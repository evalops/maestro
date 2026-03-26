/**
 * Sandbox Executor - Host, Docker, or Daytona execution environments
 *
 * Provides isolated command execution for the Slack agent. Supports four modes:
 * - Host: Direct execution on the host machine (not recommended for production)
 * - Docker (existing): Use an existing container by name
 * - Docker (auto): Automatically create and manage a container
 * - Daytona: Cloud sandbox with preview URLs, file system API, and git operations
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
	  }
	| {
			type: "daytona";
			apiKey?: string;
			apiUrl?: string;
			snapshot?: string;
			image?: string;
			language?: string;
			cpu?: number;
			memory?: number;
			disk?: number;
			autoStopInterval?: number;
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
 * - "daytona" - Cloud sandbox with Daytona (default snapshot)
 * - "daytona:snapshot-name" - Cloud sandbox with specific Daytona snapshot
 */
export function parseSandboxArg(value: string): SandboxConfig {
	if (value === "host") {
		return { type: "host" };
	}

	if (value === "daytona") {
		return { type: "daytona" };
	}

	if (value.startsWith("daytona:")) {
		const snapshot = value.slice("daytona:".length);
		if (!snapshot) {
			console.error(
				"Error: daytona:<snapshot> requires a snapshot name (e.g., daytona:my-snapshot)",
			);
			process.exit(1);
		}
		return { type: "daytona", snapshot };
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
		`Error: Invalid sandbox type '${value}'. Use 'host', 'docker:<container-name>', 'docker:auto', or 'daytona'`,
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

	if (config.type === "daytona") {
		const apiKey = config.apiKey || process.env.DAYTONA_API_KEY;
		if (!apiKey) {
			console.error(
				"Error: Daytona sandbox requires DAYTONA_API_KEY environment variable or --daytona-api-key flag",
			);
			process.exit(1);
		}
		const snapshot = config.snapshot ? ` (snapshot: ${config.snapshot})` : "";
		console.log(`Daytona cloud sandbox mode enabled${snapshot}.`);
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
 * Create an executor that runs commands either on host, in Docker container, or in Daytona sandbox
 */
export function createExecutor(config: SandboxConfig): Executor {
	if (config.type === "host") {
		return new HostExecutor();
	}

	if (config.type === "daytona") {
		return new DaytonaExecutor(config);
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

	/**
	 * Get a public preview URL for a port running in the sandbox.
	 * Only available for Daytona executors; returns undefined for others.
	 */
	getPreviewUrl?(
		port: number,
		expiresInSeconds?: number,
	): Promise<{ url: string; token: string } | undefined>;

	/**
	 * Upload a file to the sandbox filesystem.
	 * Only available for Daytona executors.
	 */
	uploadFile?(content: Buffer, remotePath: string): Promise<void>;

	/**
	 * Download a file from the sandbox filesystem.
	 * Only available for Daytona executors.
	 */
	downloadFile?(remotePath: string): Promise<Buffer>;

	/**
	 * Clone a git repository into the sandbox.
	 * Only available for Daytona executors.
	 */
	gitClone?(url: string, path: string, branch?: string): Promise<void>;

	/**
	 * Get the Daytona sandbox ID (for Daytona executors).
	 * Returns undefined for non-Daytona executors.
	 */
	getSandboxId?(): string | undefined;
}

export interface ExecOptions {
	timeout?: number;
	signal?: AbortSignal;
	cwd?: string;
	env?: Record<string, string>;
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
		try {
			return await this.initPromise;
		} catch (err) {
			// Clear cached promise so subsequent calls can retry
			this.initPromise = null;
			throw err;
		}
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

/**
 * Daytona configuration extracted from SandboxConfig
 */
interface DaytonaSandboxConfig {
	apiKey?: string;
	apiUrl?: string;
	snapshot?: string;
	image?: string;
	language?: string;
	cpu?: number;
	memory?: number;
	disk?: number;
	autoStopInterval?: number;
}

/**
 * Daytona cloud sandbox executor.
 *
 * Uses the Daytona SDK to create and manage sandboxes with:
 * - Command execution via `sandbox.process.executeCommand`
 * - File operations via `sandbox.fs`
 * - Git operations via `sandbox.git`
 * - Preview URLs via `sandbox.getSignedPreviewUrl`
 */
class DaytonaExecutor implements Executor {
	private sandbox: DaytonaSandboxInstance | null = null;
	private daytonaClient: DaytonaClient | null = null;
	private config: DaytonaSandboxConfig;
	private initPromise: Promise<void> | null = null;
	private disposed = false;
	private workDir: string | null = null;

	constructor(config: DaytonaSandboxConfig) {
		this.config = config;
	}

	private async ensureSandbox(): Promise<DaytonaSandboxInstance> {
		if (this.disposed) {
			throw new Error("Daytona executor has been disposed");
		}

		if (this.sandbox) {
			return this.sandbox;
		}

		if (this.initPromise) {
			await this.initPromise;
			return this.sandbox!;
		}

		this.initPromise = this.createSandbox();
		try {
			await this.initPromise;
		} catch (err) {
			// Clear cached promise so subsequent calls can retry
			this.initPromise = null;
			throw err;
		}
		return this.sandbox!;
	}

	private async createSandbox(): Promise<void> {
		// Dynamic import to avoid requiring the SDK when using Docker/host modes
		const { Daytona } = await import("@daytonaio/sdk");

		const apiKey = this.config.apiKey || process.env.DAYTONA_API_KEY;
		if (!apiKey) {
			throw new Error(
				"Daytona sandbox requires DAYTONA_API_KEY environment variable",
			);
		}

		this.daytonaClient = new Daytona({
			apiKey,
			...(this.config.apiUrl ? { apiUrl: this.config.apiUrl } : {}),
		});

		const createParams: Record<string, unknown> = {
			language: this.config.language || "typescript",
			envVars: { TERM: "xterm-256color" },
			autoStopInterval: this.config.autoStopInterval ?? 30,
		};

		if (this.config.snapshot) {
			createParams.snapshot = this.config.snapshot;
		}

		if (this.config.image) {
			createParams.image = this.config.image;
			if (
				this.config.cpu !== undefined ||
				this.config.memory !== undefined ||
				this.config.disk !== undefined
			) {
				createParams.resources = {
					...(this.config.cpu !== undefined ? { cpu: this.config.cpu } : {}),
					...(this.config.memory !== undefined
						? { memory: this.config.memory }
						: {}),
					...(this.config.disk !== undefined ? { disk: this.config.disk } : {}),
				};
			}
		}

		// Use type assertion since createParams can be either snapshot or image params
		this.sandbox = (await this.daytonaClient.create(
			createParams as Parameters<typeof this.daytonaClient.create>[0],
			{ timeout: 120 },
		)) as DaytonaSandboxInstance;

		this.workDir = (await this.sandbox.getUserHomeDir()) ?? "/home/daytona";

		console.log(
			`Created Daytona sandbox: ${this.sandbox.id} (workDir: ${this.workDir})`,
		);
	}

	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		const sandbox = await this.ensureSandbox();

		try {
			const response = await sandbox.process.executeCommand(
				command,
				options?.cwd ?? this.workDir ?? undefined,
				options?.env,
				options?.timeout,
			);

			return {
				stdout: response.result ?? "",
				stderr: "",
				code: response.exitCode ?? 0,
			};
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return {
				stdout: "",
				stderr: msg,
				code: 1,
			};
		}
	}

	getWorkspacePath(_hostPath: string): string {
		return this.workDir ?? "/home/daytona";
	}

	getContainerName(): string | undefined {
		return this.sandbox?.id;
	}

	getSandboxId(): string | undefined {
		return this.sandbox?.id;
	}

	async getPreviewUrl(
		port: number,
		expiresInSeconds = 3600,
	): Promise<{ url: string; token: string } | undefined> {
		const sandbox = await this.ensureSandbox();
		const preview = await sandbox.getSignedPreviewUrl(port, expiresInSeconds);
		return { url: preview.url, token: preview.token };
	}

	async uploadFile(content: Buffer, remotePath: string): Promise<void> {
		const sandbox = await this.ensureSandbox();
		await sandbox.fs.uploadFile(content, remotePath);
	}

	async downloadFile(remotePath: string): Promise<Buffer> {
		const sandbox = await this.ensureSandbox();
		const content = await sandbox.fs.downloadFile(remotePath);
		return Buffer.from(content);
	}

	async gitClone(url: string, path: string, branch?: string): Promise<void> {
		const sandbox = await this.ensureSandbox();
		if (branch) {
			await sandbox.git.clone(url, path, branch);
		} else {
			await sandbox.git.clone(url, path);
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;

		if (this.sandbox && this.daytonaClient) {
			try {
				await this.daytonaClient.delete(
					this.sandbox as Parameters<typeof this.daytonaClient.delete>[0],
				);
				console.log(`Deleted Daytona sandbox: ${this.sandbox.id}`);
			} catch {
				// Sandbox may have already been stopped/deleted
			}
			this.sandbox = null;
			this.daytonaClient = null;
		}
	}
}

/**
 * Minimal type for the Daytona SDK client to avoid requiring the import at module level.
 * The actual Daytona class is loaded dynamically.
 */
type DaytonaClient = {
	create(params?: unknown, options?: { timeout?: number }): Promise<unknown>;
	delete(sandbox: unknown, timeout?: number): Promise<void>;
};

/**
 * Minimal type for the Daytona Sandbox instance.
 * The actual Sandbox class is loaded dynamically.
 */
type DaytonaSandboxInstance = {
	id: string;
	process: {
		executeCommand(
			command: string,
			cwd?: string,
			env?: Record<string, string>,
			timeout?: number,
		): Promise<{ result: string; exitCode: number }>;
	};
	fs: {
		uploadFile(content: Buffer, path: string): Promise<void>;
		downloadFile(path: string): Promise<Buffer>;
	};
	git: {
		clone(url: string, path: string, branch?: string): Promise<void>;
	};
	getUserHomeDir(): Promise<string | undefined>;
	getPreviewLink(port: number): Promise<{ url: string; token: string }>;
	getSignedPreviewUrl(
		port: number,
		expiresInSeconds?: number,
	): Promise<{ url: string; token: string }>;
};

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
