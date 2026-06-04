import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
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

function allowedRunScripts(): Set<string> {
	const configured = process.env.MAESTRO_RUN_SCRIPT_ALLOWLIST ?? "db:migrate";
	return new Set(
		configured
			.split(",")
			.map((script) => script.trim())
			.filter((script) => script.length > 0),
	);
}

function sortedAllowedScriptsFrom(
	availableScripts: Record<string, string>,
	allowlist: Set<string>,
): string[] {
	return Object.keys(availableScripts)
		.filter((script) => allowlist.has(script))
		.sort();
}

function sortedAllowlist(allowlist: Set<string>): string[] {
	return [...allowlist].sort();
}

function runnerSupportsIgnoreScripts(runner: string): boolean {
	const executableName = runner.split(/[\\/]/).pop()?.toLowerCase();
	return executableName === "npm" || executableName === "npm.cmd";
}

type ScriptRunner = {
	executable: string;
	displayName: string;
};

async function scriptRunnerCommand(): Promise<ScriptRunner | null> {
	const configured = process.env.MAESTRO_SCRIPT_RUNNER?.trim();
	if (configured) {
		return runnerSupportsIgnoreScripts(configured)
			? { executable: configured, displayName: configured }
			: null;
	}
	const npmPath = await executableOnPath("npm");
	return npmPath ? { executable: npmPath, displayName: "npm" } : null;
}

async function executableOnPath(name: string): Promise<string | null> {
	return await new Promise((resolve) => {
		const child = spawn("sh", ["-c", `command -v ${name}`], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		let stdout = "";
		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.on("close", (code) => {
			const executable = stdout.trim().split(/\r?\n/, 1)[0];
			resolve(code === 0 && executable ? executable : null);
		});
		child.on("error", () => {
			resolve(null);
		});
	});
}

function runnerArgsForScript(runner: string, script: string): string[] {
	const args: string[] = [];
	if (runnerSupportsIgnoreScripts(runner)) {
		args.push("--ignore-scripts");
	}
	args.push("run", script);
	return args;
}

function scriptRunDisplay(
	runner: string,
	script: string,
	args: string,
): string {
	return args
		? `${runner} run ${script} -- ${args}`
		: `${runner} run ${script}`;
}

async function runPackageScript(
	runner: ScriptRunner,
	script: string,
	args: string,
): Promise<{
	success: boolean;
	code: number;
	stdout: string;
	stderr: string;
	command: string;
}> {
	const runnerArgs = runnerArgsForScript(runner.executable, script);
	const trimmedArgs = args.trim();
	if (trimmedArgs) {
		runnerArgs.push("--", ...trimmedArgs.split(/\s+/));
	}

	return await new Promise((resolve, reject) => {
		const child = spawn(runner.executable, runnerArgs, {
			cwd: process.cwd(),
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("close", (code) => {
			resolve({
				success: code === 0,
				code: code ?? -1,
				stdout: stdout.trimEnd(),
				stderr: stderr.trimEnd(),
				command: scriptRunDisplay(runner.displayName, script, trimmedArgs),
			});
		});
		child.on("error", reject);
	});
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
				const availableScripts = loadPackageScripts();
				const scripts = sortedAllowedScriptsFrom(
					availableScripts,
					allowedRunScripts(),
				);
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

			const availableScripts = loadPackageScripts();
			const allowlist = allowedRunScripts();
			if (!allowlist.has(script)) {
				sendJson(
					res,
					403,
					{
						error: `Script "${script}" is not allowed in this environment`,
						allowed: sortedAllowlist(allowlist),
					},
					corsHeaders,
				);
				return;
			}

			// Verify script exists in package.json
			if (!Object.hasOwn(availableScripts, script)) {
				sendJson(
					res,
					400,
					{
						error: `Script "${script}" not found in package.json`,
						available: sortedAllowedScriptsFrom(availableScripts, allowlist),
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

			const runner = await scriptRunnerCommand();
			if (!runner) {
				sendJson(
					res,
					503,
					{
						error:
							"No JavaScript package runner with lifecycle suppression is available for /api/run. Install npm or set MAESTRO_SCRIPT_RUNNER to an npm-compatible runner.",
					},
					corsHeaders,
				);
				return;
			}

			const result = await runPackageScript(runner, script, args ?? "");

			sendJson(
				res,
				200,
				{
					success: result.success,
					exitCode: result.code ?? 0,
					stdout: result.stdout,
					stderr: result.stderr,
					command: result.command,
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
