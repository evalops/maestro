import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DockerSandbox, type DockerSandboxConfig } from "./docker-sandbox.js";
import { LocalSandbox } from "./local-sandbox.js";
import type { Sandbox } from "./types.js";

export type { Sandbox, ExecResult } from "./types.js";
export { DockerSandbox, type DockerSandboxConfig } from "./docker-sandbox.js";
export { LocalSandbox } from "./local-sandbox.js";

export type SandboxMode = "docker" | "local" | "none";

export interface SandboxConfig {
	mode: SandboxMode;
	docker?: DockerSandboxConfig;
}

/**
 * Loads sandbox configuration from .composer/sandbox.json if present.
 * Returns undefined if no config file exists.
 */
export function loadSandboxConfig(cwd: string): SandboxConfig | undefined {
	const configPath = join(cwd, ".composer", "sandbox.json");
	if (!existsSync(configPath)) {
		return undefined;
	}

	try {
		const content = readFileSync(configPath, "utf-8");
		return JSON.parse(content) as SandboxConfig;
	} catch (error) {
		console.warn(
			`[sandbox] Failed to load sandbox config from ${configPath}:`,
			error instanceof Error ? error.message : String(error),
		);
		return undefined;
	}
}

/**
 * Checks if Docker is available on the system.
 */
async function isDockerAvailable(): Promise<boolean> {
	const { exec } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const execAsync = promisify(exec);

	try {
		await execAsync("docker info");
		return true;
	} catch {
		return false;
	}
}

export interface CreateSandboxOptions {
	/** Explicit mode override */
	mode?: SandboxMode;
	/** Working directory for config lookup */
	cwd?: string;
	/** Docker-specific configuration */
	docker?: DockerSandboxConfig;
}

/**
 * Creates a sandbox instance based on the specified mode.
 *
 * @param options - Configuration options for sandbox creation
 * @returns A Sandbox instance (Docker or Local) or undefined for "none" mode
 *
 * @example
 * ```typescript
 * // Auto-detect based on config file
 * const sandbox = await createSandbox();
 *
 * // Force Docker mode
 * const dockerSandbox = await createSandbox({ mode: "docker" });
 *
 * // No sandbox
 * const noSandbox = await createSandbox({ mode: "none" });
 * ```
 */
export async function createSandbox(
	options: CreateSandboxOptions = {},
): Promise<Sandbox | undefined> {
	const cwd = options.cwd ?? process.cwd();

	// Priority: explicit mode > env var > config file > auto-detect
	let mode: SandboxMode = options.mode ?? "none";
	let dockerConfig = options.docker;

	// Check environment variable
	const envMode = process.env.COMPOSER_SANDBOX_MODE as SandboxMode | undefined;
	if (!options.mode && envMode) {
		mode = envMode;
	}

	// Check config file if no explicit mode
	if (!options.mode && !envMode) {
		const config = loadSandboxConfig(cwd);
		if (config) {
			mode = config.mode;
			dockerConfig = config.docker ?? dockerConfig;
		}
	}

	// Handle each mode
	switch (mode) {
		case "none":
			return undefined;

		case "local":
			return new LocalSandbox();

		case "docker": {
			// Check Docker availability
			const dockerAvailable = await isDockerAvailable();
			if (!dockerAvailable) {
				console.warn(
					"[sandbox] Docker not available. Falling back to local sandbox.",
				);
				return new LocalSandbox();
			}

			const sandbox = new DockerSandbox({
				image: dockerConfig?.image ?? "node:20-slim",
				workspaceMount: dockerConfig?.workspaceMount ?? "/workspace",
			});

			// Initialize the container
			try {
				await sandbox.initialize();
				return sandbox;
			} catch (error) {
				console.warn(
					"[sandbox] Failed to initialize Docker sandbox:",
					error instanceof Error ? error.message : String(error),
				);
				console.warn("[sandbox] Falling back to local sandbox.");
				return new LocalSandbox();
			}
		}

		default:
			console.warn(`[sandbox] Unknown sandbox mode: ${mode}. Using none.`);
			return undefined;
	}
}

/**
 * Cleans up a sandbox instance, stopping containers if needed.
 */
export async function disposeSandbox(
	sandbox: Sandbox | undefined,
): Promise<void> {
	if (sandbox) {
		await sandbox.dispose();
	}
}
