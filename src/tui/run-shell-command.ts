import { spawn } from "node:child_process";

export interface ShellCommandResult {
	success: boolean;
	code: number;
	stdout: string;
	stderr: string;
}

export interface ShellCommandOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

export async function runShellCommand(
	command: string,
	options: ShellCommandOptions = {},
): Promise<ShellCommandResult> {
	return await new Promise((resolve) => {
		const child = spawn("bash", ["-lc", command], {
			cwd: options.cwd ?? process.cwd(),
			env: options.env ?? process.env,
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
			});
		});
		child.on("error", (error) => {
			resolve({
				success: false,
				code: -1,
				stdout,
				stderr:
					error instanceof Error ? error.message : String(error ?? "unknown"),
			});
		});
	});
}
