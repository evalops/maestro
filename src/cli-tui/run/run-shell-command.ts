import { spawn } from "node:child_process";

export interface ShellCommandResult {
	success: boolean;
	code: number;
	stdout: string;
	stderr: string;
	cwdChanged?: boolean;
}

export interface ShellCommandOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

function shellEscape(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function runShellCommand(
	command: string,
	options: ShellCommandOptions = {},
): Promise<ShellCommandResult> {
	return await new Promise((resolve) => {
		const cwd = options.cwd ?? process.cwd();
		const shellCommand = `cd -- ${shellEscape(cwd)} && ${command}`;
		const child = spawn("bash", ["-lc", shellCommand], {
			cwd,
			env: {
				...(options.env ?? process.env),
				PWD: cwd,
			},
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
