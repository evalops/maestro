import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { createLogger } from "../utils/logger.js";
import type { ExecResult, Sandbox } from "./types.js";

const logger = createLogger("sandbox:docker");

const execAsync = promisify(exec);

export interface DockerSandboxConfig {
	image?: string;
	workspaceMount?: string;
}

export class DockerSandbox implements Sandbox {
	private containerId: string | null = null;
	private image: string;
	private workspaceMount: string;

	constructor(config: DockerSandboxConfig = {}) {
		this.image = config.image || "node:20-slim";
		this.workspaceMount = config.workspaceMount || "/workspace";
	}

	async initialize(): Promise<void> {
		if (this.containerId) return;

		// Start a detached container that stays alive
		const name = `composer-sandbox-${randomUUID()}`;
		const cmd = `docker run -d --rm --name ${name} -v "${process.cwd()}:${this.workspaceMount}" -w ${this.workspaceMount} ${this.image} tail -f /dev/null`;

		try {
			const { stdout } = await execAsync(cmd);
			this.containerId = stdout.trim();
		} catch (error) {
			throw new Error(`Failed to start docker sandbox: ${error}`);
		}
	}

	private async ensureContainer(): Promise<string> {
		if (!this.containerId) {
			await this.initialize();
		}
		if (!this.containerId) {
			throw new Error("Sandbox not initialized");
		}
		return this.containerId;
	}

	async exec(
		command: string,
		cwd?: string,
		env?: Record<string, string>,
	): Promise<ExecResult> {
		const id = await this.ensureContainer();

		let dockerCmd = "docker exec";
		if (cwd) {
			dockerCmd += ` -w "${cwd}"`;
		}
		if (env) {
			for (const [k, v] of Object.entries(env)) {
				dockerCmd += ` -e ${k}="${v}"`;
			}
		}
		dockerCmd += ` ${id} sh -c "${command.replace(/"/g, '\\"')}"`;

		try {
			const { stdout, stderr } = await execAsync(dockerCmd);
			return { stdout, stderr, exitCode: 0 };
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
		const result = await this.exec(`cat "${path}"`);
		if (result.exitCode !== 0) {
			throw new Error(`Failed to read file: ${result.stderr}`);
		}
		return result.stdout;
	}

	async writeFile(path: string, content: string): Promise<void> {
		// Use printf to avoid echo escaping issues, or base64 for binary safety
		// Simple approach: echo for text
		const result = await this.exec(
			`echo "${content.replace(/"/g, '\\"')}" > "${path}"`,
		);
		if (result.exitCode !== 0) {
			throw new Error(`Failed to write file: ${result.stderr}`);
		}
	}

	async exists(path: string): Promise<boolean> {
		const result = await this.exec(`test -e "${path}"`);
		return result.exitCode === 0;
	}

	async dispose(): Promise<void> {
		if (this.containerId) {
			try {
				await execAsync(`docker stop ${this.containerId}`); // --rm handles removal
			} catch (err) {
				logger.debug("Failed to stop docker container during dispose", {
					containerId: this.containerId,
					error: err instanceof Error ? err.message : String(err),
				});
			}
			this.containerId = null;
		}
	}
}
