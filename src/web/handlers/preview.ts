import { execFileSync } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { requireApiAuth } from "../authz.js";
import { respondWithApiError, sendJson } from "../server-utils.js";

const PREVIEW_TIMEOUT_MS = 1_000;
const MAX_DIFF_BYTES = 50_000;

function assertPathWithinRepo(filePath: string, repoRoot: string) {
	const absolute = resolve(repoRoot, filePath);
	const normalizedRoot = resolve(repoRoot);
	if (!absolute.startsWith(`${normalizedRoot}/`)) {
		throw new Error("Invalid file path: must stay within repository");
	}
	return absolute;
}

export async function handlePreview(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	if (req.method === "GET") {
		if (!(await requireApiAuth(req, res, corsHeaders))) return;
		const url = new URL(
			req.url || "/api/preview",
			`http://${req.headers.host || "localhost"}`,
		);

		try {
			const filePath = url.searchParams.get("file");
			if (!filePath) {
				sendJson(
					res,
					400,
					{ error: "file query parameter is required" },
					corsHeaders,
				);
				return;
			}

			if (filePath.includes("..") || filePath.includes("/node_modules/")) {
				sendJson(res, 400, { error: "Invalid file path" }, corsHeaders);
				return;
			}

			try {
				const safePath = assertPathWithinRepo(filePath, process.cwd());
				execFileSync("git", ["ls-files", "--error-unmatch", safePath], {
					cwd: process.cwd(),
					stdio: "ignore",
					encoding: "utf-8",
				});
				const diff = execFileSync(
					"git",
					["diff", "--no-color", "--", safePath],
					{
						cwd: process.cwd(),
						encoding: "utf-8",
						stdio: ["ignore", "pipe", "ignore"],
						timeout: PREVIEW_TIMEOUT_MS,
					},
				);
				const trimmedDiff =
					diff.length > MAX_DIFF_BYTES
						? `${diff.slice(0, MAX_DIFF_BYTES)}\n...diff truncated (${diff.length - MAX_DIFF_BYTES} bytes omitted)`
						: diff;
				sendJson(
					res,
					200,
					{
						file: filePath,
						diff: trimmedDiff || "No changes",
						hasChanges: diff.length > 0,
					},
					corsHeaders,
				);
			} catch (error) {
				const err = error as { status?: number; stderr?: Buffer };
				if (err.status === 1) {
					sendJson(
						res,
						200,
						{
							file: filePath,
							diff: "",
							hasChanges: false,
							message: "File not tracked or no changes",
						},
						corsHeaders,
					);
				} else {
					throw error;
				}
			}
		} catch (error) {
			respondWithApiError(res, error, 500, corsHeaders, req);
		}
		return;
	}

	sendJson(res, 405, { error: "Method not allowed" }, corsHeaders);
}
