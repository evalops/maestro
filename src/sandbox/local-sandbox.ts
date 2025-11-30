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
		} catch (error: any) {
			return {
				stdout: error.stdout || "",
				stderr: error.stderr || "",
				exitCode: error.code || 1,
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
