import { spawn, spawnSync } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
	readJsonBody,
	respondWithApiError,
	sendJson,
} from "../server-utils.js";

function runOllama(args: string[]): {
	ok: boolean;
	stdout: string;
	stderr: string;
	missingCli: boolean;
} {
	try {
		const result = spawnSync("ollama", args, {
			cwd: process.cwd(),
			encoding: "utf-8",
		});
		const missing = Boolean(
			(result as { error?: NodeJS.ErrnoException }).error?.code === "ENOENT",
		);
		return {
			ok: (result.status ?? 0) === 0,
			stdout: (result.stdout ?? "").trimEnd(),
			stderr: (result.stderr ?? "").trimEnd(),
			missingCli: missing,
		};
	} catch (error) {
		const isMissing =
			(error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
		return {
			ok: false,
			stdout: "",
			stderr:
				error instanceof Error
					? error.message
					: String(error ?? "Unable to run ollama command."),
			missingCli: Boolean(isMissing),
		};
	}
}

export async function handleOllama(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	if (req.method === "GET") {
		const url = new URL(
			req.url || "/api/ollama",
			`http://${req.headers.host || "localhost"}`,
		);
		const action = url.searchParams.get("action") || "list";

		try {
			if (action === "list") {
				const result = runOllama(["list", "--json"]);
				if (result.missingCli) {
					sendJson(
						res,
						400,
						{
							error:
								"Ollama CLI not found. Install from https://ollama.com/download",
						},
						corsHeaders,
					);
					return;
				}
				if (!result.ok || !result.stdout.trim()) {
					sendJson(res, 200, { models: [] }, corsHeaders);
					return;
				}
				try {
					const models = JSON.parse(result.stdout);
					sendJson(res, 200, { models }, corsHeaders);
				} catch {
					sendJson(res, 200, { models: [] }, corsHeaders);
				}
			} else if (action === "ps") {
				const result = runOllama(["ps"]);
				if (result.missingCli) {
					sendJson(
						res,
						400,
						{
							error:
								"Ollama CLI not found. Install from https://ollama.com/download",
						},
						corsHeaders,
					);
					return;
				}
				sendJson(
					res,
					200,
					{
						ok: result.ok,
						output: result.stdout || result.stderr,
					},
					corsHeaders,
				);
			} else {
				sendJson(
					res,
					400,
					{ error: "Invalid action. Use list or ps." },
					corsHeaders,
				);
			}
		} catch (error) {
			respondWithApiError(res, error, 500, corsHeaders, req);
		}
		return;
	}

	if (req.method === "POST") {
		try {
			const data = await readJsonBody<{
				action: string;
				model?: string;
			}>(req);
			const { action, model } = data;

			if (action === "pull" && model) {
				// For pull, we'd need to stream the output
				// For now, return a simple response
				sendJson(
					res,
					202,
					{
						message: `Pulling ${model}. This is an async operation.`,
						note: "Use GET /api/ollama?action=list to check status",
					},
					corsHeaders,
				);
			} else if (action === "show" && model) {
				const result = runOllama(["show", model]);
				if (result.missingCli) {
					sendJson(
						res,
						400,
						{
							error:
								"Ollama CLI not found. Install from https://ollama.com/download",
						},
						corsHeaders,
					);
					return;
				}
				sendJson(
					res,
					result.ok ? 200 : 400,
					{
						ok: result.ok,
						output: result.stdout || result.stderr,
					},
					corsHeaders,
				);
			} else {
				sendJson(
					res,
					400,
					{ error: "Invalid action. Use pull or show with model parameter." },
					corsHeaders,
				);
			}
		} catch (error) {
			respondWithApiError(res, error, 500, corsHeaders, req);
		}
		return;
	}

	sendJson(res, 405, { error: "Method not allowed" }, corsHeaders);
}
