/**
 * DaytonaSandbox — Sandbox implementation backed by Daytona cloud sandboxes.
 *
 * Implements the standard Sandbox interface so it can be used interchangeably
 * with LocalSandbox, DockerSandbox, and NativeSandbox.
 *
 * Uses a static factory (create) because sandbox creation is async.
 * Caches the sandbox handle to avoid redundant API calls per operation.
 */

import { Daytona } from "@daytonaio/sdk";
import type { ExecResult, Sandbox } from "../../../../src/sandbox/types.js";

export interface DaytonaSandboxConfig {
	apiKey: string;
	apiUrl?: string;
	language?: string;
	ephemeral?: boolean;
}

type SandboxHandle = Awaited<
	ReturnType<InstanceType<typeof Daytona>["create"]>
>;

export class DaytonaSandbox implements Sandbox {
	private constructor(private handle: SandboxHandle) {}

	/**
	 * Create a new Daytona sandbox. This is async because it provisions
	 * a remote sandbox environment.
	 */
	static async create(config: DaytonaSandboxConfig): Promise<DaytonaSandbox> {
		const client = new Daytona({
			apiKey: config.apiKey,
			apiUrl: config.apiUrl || "https://app.daytona.io/api",
		});
		const handle = await client.create({
			language: config.language ?? "python",
			ephemeral: config.ephemeral ?? false,
		});
		return new DaytonaSandbox(handle);
	}

	get id(): string {
		return this.handle.id;
	}

	async exec(
		command: string,
		cwd?: string,
		env?: Record<string, string>,
	): Promise<ExecResult> {
		try {
			// Build command with env vars and cwd if provided
			let fullCommand = command;
			if (env && Object.keys(env).length > 0) {
				const envPrefix = Object.entries(env)
					.map(([k, v]) => {
						if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
							throw new Error(`Invalid environment variable name: ${k}`);
						}
						// Use single quotes to prevent shell interpretation
						const escaped = v.replace(/'/g, "'\\''");
						return `${k}='${escaped}'`;
					})
					.join(" ");
				fullCommand = `${envPrefix} ${fullCommand}`;
			}
			if (cwd) {
				const escapedCwd = cwd.replace(/'/g, "'\\''");
				fullCommand = `cd '${escapedCwd}' && ${fullCommand}`;
			}
			const result = await this.handle.process.executeCommand(fullCommand);
			return {
				stdout: result.result,
				stderr: "",
				exitCode: result.exitCode,
			};
		} catch (err) {
			return {
				stdout: "",
				stderr: err instanceof Error ? err.message : String(err),
				exitCode: 1,
			};
		}
	}

	async readFile(path: string): Promise<string> {
		const content = await this.handle.fs.downloadFile(path);
		return typeof content === "string" ? content : content.toString("utf-8");
	}

	async writeFile(path: string, content: string): Promise<void> {
		await this.handle.fs.uploadFile(Buffer.from(content), path);
	}

	async exists(path: string): Promise<boolean> {
		try {
			await this.handle.fs.getFileDetails(path);
			return true;
		} catch {
			return false;
		}
	}

	async list(path: string): Promise<string[]> {
		const files = await this.handle.fs.listFiles(path);
		return files.map((f: { name: string }) => f.name);
	}

	async delete(path: string, recursive?: boolean): Promise<void> {
		await this.handle.fs.deleteFile(path, recursive);
	}

	async dispose(): Promise<void> {
		try {
			await this.handle.delete();
		} catch {
			// Sandbox may already be deleted (ephemeral mode)
		}
	}
}
