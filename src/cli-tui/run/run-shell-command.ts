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

function createShellEnv(
	baseEnv: NodeJS.ProcessEnv | undefined,
	cwd: string,
): NodeJS.ProcessEnv {
	const env = { ...(baseEnv ?? process.env), PWD: cwd };
	Reflect.deleteProperty(env, "BASH_ENV");
	return env;
}

function shouldSkipBashStartupFiles(env: NodeJS.ProcessEnv): boolean {
	return env.GITHUB_ACTIONS === "true";
}

export async function runShellCommand(
	command: string,
	options: ShellCommandOptions = {},
): Promise<ShellCommandResult> {
	return await new Promise((resolve) => {
		const cwd = options.cwd ?? process.cwd();
		const shellCommand = `cd -- ${shellEscape(cwd)} && ${command}`;
		const env = createShellEnv(options.env, cwd);
		const bashArgs = shouldSkipBashStartupFiles(env)
			? ["--noprofile", "--norc", "-lc", shellCommand]
			: ["-lc", shellCommand];
		const child = spawn("bash", bashArgs, {
			cwd,
			env,
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
