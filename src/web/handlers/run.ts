import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { runShellCommand } from "../../tui/run/run-shell-command.js";
import {
	readJsonBody,
	respondWithApiError,
	sendJson,
} from "../server-utils.js";

export async function handleRun(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	if (req.method === "GET") {
		const url = new URL(
			req.url || "/api/run",
			`http://${req.headers.host || "localhost"}`,
		);
		const action = url.searchParams.get("action") || "scripts";

		try {
			if (action === "scripts") {
				try {
					const pkgPath = join(process.cwd(), "package.json");
					const raw = readFileSync(pkgPath, "utf-8");
					const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
					const scripts = pkg?.scripts ? Object.keys(pkg.scripts) : [];
					sendJson(res, 200, { scripts }, corsHeaders);
				} catch {
					sendJson(res, 200, { scripts: [] }, corsHeaders);
				}
			} else {
				sendJson(
					res,
					400,
					{ error: "Invalid action. Use scripts." },
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
			const data = await readJsonBody<{ script: string; args?: string }>(req);
			const { script, args } = data;

			if (!script) {
				sendJson(res, 400, { error: "Script name is required" }, corsHeaders);
				return;
			}

			const command = args
				? `npm run ${script} -- ${args}`
				: `npm run ${script}`;
			const result = await runShellCommand(command);

			sendJson(
				res,
				200,
				{
					success: result.success,
					exitCode: result.code ?? 0,
					stdout: result.stdout,
					stderr: result.stderr,
					command,
				},
				corsHeaders,
			);
		} catch (error) {
			respondWithApiError(res, error, 500, corsHeaders, req);
		}
		return;
	}

	sendJson(res, 405, { error: "Method not allowed" }, corsHeaders);
}
