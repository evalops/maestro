/**
 * Sandbox Executor - Host or Docker execution environments
 *
 * Provides isolated command execution for the Slack agent. Supports three modes:
 * - Host: Direct execution on the host machine (not recommended for production)
 * - Docker (existing): Use an existing container by name
 * - Docker (auto): Automatically create and manage a container
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { shellEscape } from "./utils/shell-escape.js";

export type SandboxConfig =
	| { type: "host" }
	| { type: "docker"; container: string; autoCreate?: false }
	| {
			type: "docker";
			autoCreate: true;
			image?: string;
			workspaceMount?: string;
			cpus?: string;
			memory?: string;
	  };

export interface DockerAutoConfig {
	image: string;
	workspaceMount: string;
	cpus: string;
	memory: string;
}

const DEFAULT_DOCKER_CONFIG: DockerAutoConfig = {
	image: "node:20-slim",
	workspaceMount: "/workspace",
	cpus: "2",
	memory: "2g",
};

/**
 * Parse sandbox argument from CLI
 *
 * Formats:
 * - "host" - Run on host (not recommended)
 * - "docker:container-name" - Use existing container
 * - "docker:auto" - Auto-create container with defaults
 * - "docker:auto:image:tag" - Auto-create with specific image
 */
export function parseSandboxArg(value: string): SandboxConfig {
	if (value === "host") {
		return { type: "host" };
	}

	if (value === "docker:auto") {
		return { type: "docker", autoCreate: true };
	}

	if (value.startsWith("docker:auto:")) {
		const image = value.slice("docker:auto:".length);
		if (!image) {
			console.error(
				"Error: docker:auto requires an image name (e.g., docker:auto:node:20-slim)",
			);
			process.exit(1);
		}
		return { type: "docker", autoCreate: true, image };
	}

	if (value.startsWith("docker:")) {
		const container = value.slice("docker:".length);
		if (!container) {
			console.error(
				"Error: docker sandbox requires container name (e.g., docker:slack-agent-sandbox)",
			);
			process.exit(1);
		}
		// Validate container name to prevent command injection
		// Docker container names must match [a-zA-Z0-9][a-zA-Z0-9_.-]*
		if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container)) {
			console.error(
				`Error: Invalid container name '${container}'. Container names must start with alphanumeric and contain only [a-zA-Z0-9_.-]`,
			);
			process.exit(1);
		}
		return { type: "docker", container };
	}

	console.error(
		`Error: Invalid sandbox type '${value}'. Use 'host', 'docker:<container-name>', or 'docker:auto'`,
	);
	process.exit(1);
}

/**
 * Validate that the sandbox environment is ready
 */
export async function validateSandbox(config: SandboxConfig): Promise<void> {
	if (config.type === "host") {
		console.log("Using host sandbox (no isolation).");
		return;
	}

	// Check if Docker is available
	try {
		await execSimple("docker", ["--version"]);
	} catch {
		console.error("Error: Docker is not installed or not in PATH");
		process.exit(1);
	}

	// For auto-create mode, we'll create the container lazily
	if (config.autoCreate) {
		const image = config.image || DEFAULT_DOCKER_CONFIG.image;
		console.log(`Docker auto-create mode enabled (image: ${image}).`);
		return;
	}

	// Check if container exists and is running
	try {
		const result = await execSimple("docker", [
			"inspect",
			"-f",
			"{{.State.Running}}",
			config.container,
		]);
		if (result.trim() !== "true") {
			console.error(`Error: Container '${config.container}' is not running.`);
			console.error(`Start it with: docker start ${config.container}`);
			process.exit(1);
		}
	} catch {
		console.error(`Error: Container '${config.container}' does not exist.`);
		console.error("Create a container first using docker-compose:");
		console.error("  cd packages/slack-agent && docker compose up -d");
		console.error("");
		console.error("Or create manually:");
		console.error(
			`  docker run -d --name ${config.container} -v $(pwd)/data:/workspace node:20-slim tail -f /dev/null`,
		);
		process.exit(1);
	}

	console.log(`Docker container '${config.container}' is running.`);
}

function execSimple(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		child.stdout?.on("data", (d) => {
			stdout += d;
		});
		child.stderr?.on("data", (d) => {
			stderr += d;
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			const message =
				error instanceof Error
					? `Failed to start ${cmd}: ${error.message}`
					: `Failed to start ${cmd}: ${String(error)}`;
			reject(new Error(message));
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			if (code === 0) resolve(stdout);
			else reject(new Error(stderr || `Exit code ${code}`));
		});
	});
}

/**
 * Create an executor that runs commands either on host or in Docker container
 */
export function createExecutor(config: SandboxConfig): Executor {
	if (config.type === "host") {
		return new HostExecutor();
	}

	if (config.autoCreate) {
		return new AutoDockerExecutor({
			image: config.image || DEFAULT_DOCKER_CONFIG.image,
			workspaceMount:
				config.workspaceMount || DEFAULT_DOCKER_CONFIG.workspaceMount,
			cpus: config.cpus || DEFAULT_DOCKER_CONFIG.cpus,
			memory: config.memory || DEFAULT_DOCKER_CONFIG.memory,
		});
	}

	return new DockerExecutor(config.container);
}

export interface Executor {
	/**
	 * Execute a bash command
	 */
	exec(command: string, options?: ExecOptions): Promise<ExecResult>;

	/**
	 * Get the workspace path prefix for this executor
	 * Host: returns the actual path
	 * Docker: returns /workspace
	 */
	getWorkspacePath(hostPath: string): string;

	/**
	 * Get the container name (for Docker executors)
	 * Returns undefined for host executors
	 */
	getContainerName(): string | undefined;

	/**
	 * Cleanup resources (stop container if auto-created)
	 */
	dispose(): Promise<void>;
}

export interface ExecOptions {
	timeout?: number;
	signal?: AbortSignal;
	cwd?: string;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

const MAX_OUTPUT_SIZE = 10 * 1024 * 1024; // 10MB

class HostExecutor implements Executor {
	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		return new Promise((resolve, reject) => {
			const shell = process.platform === "win32" ? "cmd" : "sh";
			const shellArgs = process.platform === "win32" ? ["/c"] : ["-c"];

			const child = spawn(shell, [...shellArgs, command], {
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
				cwd: options?.cwd,
			});

			let stdout = "";
			let stderr = "";
			let timedOut = false;
			let settled = false;

			const settleOnce = (cb: () => void) => {
				if (settled) return;
				settled = true;
				cb();
			};

			const cleanup = () => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (options?.signal) {
					options.signal.removeEventListener("abort", onAbort);
				}
			};

			const timeoutHandle =
				options?.timeout && options.timeout > 0
					? setTimeout(() => {
							timedOut = true;
							if (child.pid) killProcessTree(child.pid);
						}, options.timeout * 1000)
					: undefined;

			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};

			if (options?.signal) {
				if (options.signal.aborted) {
					onAbort();
				} else {
					options.signal.addEventListener("abort", onAbort, { once: true });
				}
			}

			child.stdout?.on("data", (data) => {
				stdout += data.toString();
				if (stdout.length > MAX_OUTPUT_SIZE) {
					stdout = stdout.slice(0, MAX_OUTPUT_SIZE);
				}
			});

			child.stderr?.on("data", (data) => {
				stderr += data.toString();
				if (stderr.length > MAX_OUTPUT_SIZE) {
					stderr = stderr.slice(0, MAX_OUTPUT_SIZE);
				}
			});

			child.on("error", (error) => {
				settleOnce(() => {
					cleanup();
					reject(error instanceof Error ? error : new Error(String(error)));
				});
			});

			child.on("close", (code) => {
				settleOnce(() => {
					cleanup();

					if (options?.signal?.aborted) {
						reject(new Error(`${stdout}\n${stderr}\nCommand aborted`.trim()));
						return;
					}

					if (timedOut) {
						reject(
							new Error(
								`${stdout}\n${stderr}\nCommand timed out after ${options?.timeout} seconds`.trim(),
							),
						);
						return;
					}

					resolve({ stdout, stderr, code: code ?? 0 });
				});
			});
		});
	}

	getWorkspacePath(hostPath: string): string {
		return hostPath;
	}

	getContainerName(): string | undefined {
		return undefined;
	}

	async dispose(): Promise<void> {
		// Nothing to clean up for host executor
	}
}

class DockerExecutor implements Executor {
	constructor(protected container: string) {}

	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		// Wrap command for docker exec
		let dockerCmd = "docker exec";
		if (options?.cwd) {
			dockerCmd += ` -w ${shellEscape(options.cwd)}`;
		}
		// Escape container name for defense-in-depth (validated at parse time)
		dockerCmd += ` ${shellEscape(this.container)} sh -c ${shellEscape(command)}`;

		const hostExecutor = new HostExecutor();
		return hostExecutor.exec(dockerCmd, {
			timeout: options?.timeout,
			signal: options?.signal,
		});
	}

	getWorkspacePath(_hostPath: string): string {
		// Docker container sees /workspace
		return "/workspace";
	}

	getContainerName(): string | undefined {
		return this.container;
	}

	async dispose(): Promise<void> {
		// Don't stop containers we didn't create
	}
}

/**
 * Auto-managed Docker executor that creates and cleans up its own container
 */
class AutoDockerExecutor implements Executor {
	private containerId: string | null = null;
	private containerName: string;
	private config: DockerAutoConfig;
	private initPromise: Promise<void> | null = null;
	private disposed = false;

	constructor(config: DockerAutoConfig) {
		this.config = config;
		this.containerName = `slack-agent-${randomUUID().slice(0, 8)}`;
	}

	private async ensureContainer(): Promise<void> {
		if (this.disposed) {
			throw new Error("Executor has been disposed");
		}

		if (this.containerId) {
			return;
		}

		if (this.initPromise) {
			return this.initPromise;
		}

		this.initPromise = this.createContainer();
		return this.initPromise;
	}

	private async createContainer(): Promise<void> {
		const cwd = process.cwd();

		const args = [
			"run",
			"-d",
			"--rm",
			"--name",
			this.containerName,
			"--cpus",
			this.config.cpus,
			"--memory",
			this.config.memory,
			"-v",
			`${cwd}:${this.config.workspaceMount}:rw`,
			"-w",
			this.config.workspaceMount,
			"--security-opt",
			"no-new-privileges:true",
			this.config.image,
			"tail",
			"-f",
			"/dev/null",
		];

		try {
			const result = await execSimple("docker", args);
			this.containerId = result.trim();
			console.log(
				`Created Docker container: ${this.containerName} (${this.containerId.slice(0, 12)})`,
			);

			// Register cleanup handler
			this.registerCleanupHandler();
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			throw new Error(`Failed to create Docker container: ${msg}`);
		}
	}

	private cleanupHandler = () => {
		// Synchronous cleanup for process exit
		if (this.containerId) {
			try {
				spawn("docker", ["stop", this.containerName], {
					stdio: "ignore",
					detached: true,
				});
			} catch {
				// Ignore cleanup errors
			}
		}
	};

	private registerCleanupHandler(): void {
		process.on("exit", this.cleanupHandler);
		process.on("SIGINT", () => {
			this.cleanupHandler();
			process.exit(130);
		});
		process.on("SIGTERM", () => {
			this.cleanupHandler();
			process.exit(143);
		});
	}

	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		await this.ensureContainer();

		let dockerCmd = "docker exec";
		if (options?.cwd) {
			dockerCmd += ` -w ${shellEscape(options.cwd)}`;
		}
		dockerCmd += ` ${this.containerName} sh -c ${shellEscape(command)}`;

		const hostExecutor = new HostExecutor();
		return hostExecutor.exec(dockerCmd, {
			timeout: options?.timeout,
			signal: options?.signal,
		});
	}

	getWorkspacePath(_hostPath: string): string {
		return this.config.workspaceMount;
	}

	getContainerName(): string | undefined {
		return this.containerName;
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;

		process.removeListener("exit", this.cleanupHandler);

		if (this.containerId) {
			try {
				await execSimple("docker", ["stop", this.containerName]);
				console.log(`Stopped Docker container: ${this.containerName}`);
			} catch {
				// Container may have already stopped
			}
			this.containerId = null;
		}
	}
}

function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			const child = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
			});
			child.on("error", () => {});
		} catch {
			// Ignore errors
		}
	} else {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already dead
			}
		}
	}
}
