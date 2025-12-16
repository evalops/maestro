import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { runShellCommand } from "../../cli-tui/run/run-shell-command.js";
import {
	readJsonBody,
	respondWithApiError,
	sendJson,
} from "../server-utils.js";

/**
 * Shell metacharacters that could enable command injection.
 * This pattern matches dangerous characters used in shell expansion, command chaining, etc.
 */
const SHELL_METACHAR_PATTERN = /[;&|`$(){}[\]<>\\!#*?"'\n\r\t]/;

/**
 * Validate that a script name is safe (alphanumeric, hyphens, underscores, colons, periods only).
 * This matches the typical npm script naming conventions.
 */
function isValidScriptName(script: string): boolean {
	return /^[a-zA-Z0-9_:.-]+$/.test(script) && script.length <= 100;
}

/**
 * Check if args contain dangerous shell metacharacters.
 */
function containsShellMetachars(value: string): boolean {
	return SHELL_METACHAR_PATTERN.test(value);
}

/**
 * Load scripts from package.json
 */
function loadPackageScripts(): Record<string, string> {
	try {
		const pkgPath = join(process.cwd(), "package.json");
		const raw = readFileSync(pkgPath, "utf-8");
		const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
		return pkg?.scripts ?? {};
	} catch {
		return {};
	}
}

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
				const scripts = Object.keys(loadPackageScripts());
				sendJson(res, 200, { scripts }, corsHeaders);
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

			// Validate script name format
			if (!isValidScriptName(script)) {
				sendJson(
					res,
					400,
					{ error: "Invalid script name format" },
					corsHeaders,
				);
				return;
			}

			// Verify script exists in package.json
			const availableScripts = loadPackageScripts();
			if (!Object.hasOwn(availableScripts, script)) {
				sendJson(
					res,
					400,
					{
						error: `Script "${script}" not found in package.json`,
						available: Object.keys(availableScripts),
					},
					corsHeaders,
				);
				return;
			}

			// Validate args for shell metacharacters
			if (args && containsShellMetachars(args)) {
				sendJson(
					res,
					400,
					{
						error:
							"Arguments contain invalid characters. Shell metacharacters are not allowed.",
					},
					corsHeaders,
				);
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
