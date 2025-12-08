/**
 * Local Sandbox - Direct Filesystem Execution
 *
 * This module provides a non-isolated sandbox that executes commands and
 * file operations directly on the local filesystem. It implements the
 * Sandbox interface for consistency but provides no actual isolation.
 *
 * ## Use Cases
 *
 * - Default execution environment when Docker is unavailable
 * - Development and testing scenarios
 * - Trusted workspace operations
 *
 * ## Operations
 *
 * | Method     | Description                               |
 * |------------|-------------------------------------------|
 * | exec()     | Run shell command via child_process       |
 * | readFile() | Read file contents using fs.readFile      |
 * | writeFile()| Write file contents using fs.writeFile    |
 * | exists()   | Check file existence using fs.access      |
 * | list()     | List directory contents                   |
 *
 * ## Security Note
 *
 * This sandbox provides NO isolation. Commands run with the same
 * permissions as the Composer process. Use DockerSandbox for
 * isolated execution in untrusted environments.
 *
 * @module sandbox/local-sandbox
 */

import { exec } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { ExecResult, Sandbox } from "./types.js";

const execAsync = promisify(exec);

export class LocalSandbox implements Sandbox {
	async exec(
		command: string,
		cwd?: string,
		env?: Record<string, string>,
	): Promise<ExecResult> {
		try {
			const { stdout, stderr } = await execAsync(command, {
				cwd,
				env: { ...process.env, ...env },
			});
			return {
				stdout,
				stderr,
				exitCode: 0, // execAsync throws on non-zero exit, so if we're here it's 0
			};
		} catch (error: unknown) {
			const execError = error as {
				stdout?: string;
				stderr?: string;
				code?: number;
			};
			return {
				stdout: execError.stdout || "",
				stderr: execError.stderr || "",
				exitCode: execError.code || 1,
			};
		}
	}

	async readFile(path: string): Promise<string> {
		return readFile(path, "utf-8");
	}

	async writeFile(path: string, content: string): Promise<void> {
		await writeFile(path, content, "utf-8");
	}

	async exists(path: string): Promise<boolean> {
		try {
			await access(path, constants.F_OK);
			return true;
		} catch {
			return false;
		}
	}

	async dispose(): Promise<void> {
		// Nothing to clean up for local sandbox
	}
}
