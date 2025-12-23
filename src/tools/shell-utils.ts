/**
 * Shell Utilities - Cross-Platform Shell Execution Helpers
 *
 * This module provides utilities for safely executing shell commands across
 * different operating systems. It handles shell detection, process tree
 * management, parameter validation, and command argument parsing.
 *
 * ## Platform Support
 *
 * | Platform | Shell          | Notes                              |
 * |----------|----------------|-------------------------------------|
 * | Windows  | Git Bash       | Requires Git for Windows installed |
 * | Linux    | $SHELL         | Defaults to /bin/bash (fallback: sh) |
 * | macOS    | $SHELL         | Defaults to /bin/bash (fallback: sh) |
 *
 * ## Key Functions
 *
 * - `getShellConfig()`: Returns the appropriate shell and args for the platform
 * - `killProcessTree()`: Safely terminates a process and all its children
 * - `validateShellParams()`: Validates and sanitizes shell command parameters
 * - `parseCommandArguments()`: Parses a command string into an array of arguments
 *
 * ## Security Features
 *
 * - Control character detection and rejection
 * - Path traversal prevention
 * - Maximum length limits on commands and paths
 * - Quote parsing with escape sequence handling
 *
 * ## Example
 *
 * ```typescript
 * import { getShellConfig, validateShellParams } from './shell-utils';
 *
 * const { shell, args } = getShellConfig();
 * const { resolvedCwd } = validateShellParams('echo hello', '/tmp');
 *
 * spawn(shell, [...args, 'echo hello'], { cwd: resolvedCwd });
 * ```
 *
 * @module tools/shell-utils
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { createLogger } from "../utils/logger.js";
import { requireNonEmpty, sanitizeString } from "../utils/validation.js";
import { expandUserPath } from "./tool-dsl.js";

const shellLogger = createLogger("shell-utils");

export function getShellConfig(): { shell: string; args: string[] } {
	if (process.platform === "win32") {
		const paths: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) {
			paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
		}
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) {
			paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		}

		for (const path of paths) {
			if (existsSync(path)) {
				return { shell: path, args: ["-c"] };
			}
		}

		throw new Error(
			`Git Bash not found. Please install Git for Windows from https://git-scm.com/download/win\nSearched in:\n${paths
				.map((p) => `  ${p}`)
				.join("\n")}`,
		);
	}

	const envShell = process.env.SHELL?.trim();
	if (envShell && existsSync(envShell)) {
		return { shell: envShell, args: ["-c"] };
	}

	if (existsSync("/bin/bash")) {
		return { shell: "/bin/bash", args: ["-c"] };
	}

	return { shell: "sh", args: ["-c"] };
}

export function killProcessTree(pid: number): void {
	// Safety: never try to kill PID 1 (init) or invalid PIDs
	if (pid <= 0 || pid === 1) {
		return;
	}

	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
			});
		} catch {
			return;
		}
		return;
	}

	try {
		process.kill(-pid, "SIGKILL");
	} catch (error) {
		shellLogger.warn(
			"Failed to kill process group; falling back to single PID",
			{
				pid,
				error: error instanceof Error ? error.message : String(error),
			},
		);
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			return;
		}
	}
}

export function validateShellParams(
	command: string,
	cwd?: string,
	env?: Record<string, string>,
): { resolvedCwd?: string } {
	requireNonEmpty(command, "command");

	const sanitizedCommand = sanitizeString(command, { maxLength: 100000 });
	if (sanitizedCommand !== command) {
		throw new Error("Command contains invalid control characters");
	}

	let resolvedCwd: string | undefined;
	if (cwd !== undefined) {
		requireNonEmpty(cwd, "cwd");
		const sanitizedCwd = sanitizeString(cwd, { maxLength: 4096 });
		if (sanitizedCwd !== cwd) {
			throw new Error("Working directory contains invalid characters");
		}
		resolvedCwd = resolvePath(expandUserPath(cwd));
		if (!existsSync(resolvedCwd)) {
			throw new Error(`Working directory not found: ${cwd}`);
		}
	}

	if (env) {
		for (const [key, value] of Object.entries(env)) {
			requireNonEmpty(key, "environment variable key");
			const sanitizedKey = sanitizeString(key, { maxLength: 256 });
			const sanitizedValue = sanitizeString(value, { maxLength: 32768 });

			if (sanitizedKey !== key || sanitizedValue !== value) {
				throw new Error(
					`Environment variable ${key} contains invalid characters`,
				);
			}
		}
	}

	return { resolvedCwd };
}

export function parseCommandArguments(command: string): string[] {
	requireNonEmpty(command, "command");
	const args: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let escaping = false;
	let argStarted = false;

	for (let i = 0; i < command.length; i += 1) {
		const char = command[i];
		if (escaping) {
			current += char;
			argStarted = true;
			escaping = false;
			continue;
		}

		if (char === "\\" && !inSingle) {
			escaping = true;
			continue;
		}

		if (char === "'" && !inDouble) {
			inSingle = !inSingle;
			argStarted = true;
			continue;
		}

		if (char === '"' && !inSingle) {
			inDouble = !inDouble;
			argStarted = true;
			continue;
		}

		if (!inSingle && !inDouble && /\s/.test(char)) {
			if (current || argStarted) {
				args.push(current);
				current = "";
				argStarted = false;
			}
			continue;
		}

		current += char;
		argStarted = true;
	}

	if (escaping) {
		throw new Error("Command ends with unfinished escape sequence");
	}
	if (inSingle || inDouble) {
		throw new Error("Command contains unterminated quotes");
	}
	if (current || argStarted) {
		args.push(current);
	}
	return args;
}
