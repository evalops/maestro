import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DockerSandbox, type DockerSandboxConfig } from "./docker-sandbox.js";
import { LocalSandbox } from "./local-sandbox.js";
import {
	NativeSandbox,
	type NativeSandboxMode,
	type NativeSandboxPolicy,
	createNativeSandbox,
	getNativeSandboxType,
	isNativeSandboxAvailable,
} from "./native-sandbox.js";
import type { Sandbox } from "./types.js";

export type { Sandbox, ExecResult } from "./types.js";
export { DockerSandbox, type DockerSandboxConfig } from "./docker-sandbox.js";
export { LocalSandbox } from "./local-sandbox.js";
export {
	NativeSandbox,
	isNativeSandboxAvailable,
	getNativeSandboxType,
	createNativeSandbox,
	type NativeSandboxPolicy,
	type NativeSandboxMode,
} from "./native-sandbox.js";

export type SandboxMode = "docker" | "local" | "native" | "none";

export interface NativeSandboxConfig {
	/** Sandbox policy mode */
	policy?: NativeSandboxMode;
	/** Additional writable directories */
	writableRoots?: string[];
	/** Allow network access */
	networkAccess?: boolean;
}

export interface SandboxConfig {
	mode: SandboxMode;
	docker?: DockerSandboxConfig;
	native?: NativeSandboxConfig;
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
		console.warn("[sandbox] Failed to load sandbox config", {
			configPath,
			error: error instanceof Error ? error.message : String(error),
		});
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
	/** Native sandbox configuration */
	native?: NativeSandboxConfig;
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
	const isWebServer = process.env.COMPOSER_WEB_SERVER === "1";

	// Priority: explicit mode > env var > config file > auto-detect
	let mode: SandboxMode = options.mode ?? "none";
	let dockerConfig = options.docker;
	let nativeConfig = options.native;

	// Check environment variable (handle "undefined" string from process.env assignment)
	const envModeRaw = process.env.COMPOSER_SANDBOX_MODE;
	const envMode =
		envModeRaw && envModeRaw !== "undefined"
			? (envModeRaw as SandboxMode)
			: undefined;
	if (!options.mode && envMode) {
		mode = envMode;
	}

	// Check config file if no explicit mode
	if (!options.mode && !envMode) {
		const config = loadSandboxConfig(cwd);
		if (config) {
			mode = config.mode;
			dockerConfig = config.docker ?? dockerConfig;
			nativeConfig = config.native ?? nativeConfig;
		}
	}

	// Handle each mode
	switch (mode) {
		case "none":
			return undefined;

		case "local":
			if (isWebServer) {
				throw new Error(
					"Local sandbox is disabled in web-server mode. Use Docker sandbox or COMPOSER_SANDBOX_MODE=none.",
				);
			}
			return new LocalSandbox();

		case "native": {
			// Check native sandbox availability
			if (!isNativeSandboxAvailable()) {
				const sandboxType = getNativeSandboxType();
				console.warn(
					`[sandbox] Native sandbox (${sandboxType}) not available on this platform.`,
				);
				const fallback = isWebServer ? "none" : "local";
				console.warn(`[sandbox] Falling back to ${fallback} sandbox.`);
				return isWebServer ? undefined : new LocalSandbox();
			}

			const policy: NativeSandboxPolicy = {
				mode: nativeConfig?.policy ?? "workspace-write",
				writableRoots: nativeConfig?.writableRoots,
				networkAccess: nativeConfig?.networkAccess ?? true,
			};

			const sandbox = createNativeSandbox(policy, cwd);

			try {
				await sandbox.initialize();
				return sandbox;
			} catch (error) {
				console.warn(
					"[sandbox] Failed to initialize native sandbox:",
					error instanceof Error ? error.message : String(error),
				);
				const fallback = isWebServer ? "none" : "local";
				console.warn(`[sandbox] Falling back to ${fallback} sandbox.`);
				return isWebServer ? undefined : new LocalSandbox();
			}
		}

		case "docker": {
			// Check Docker availability
			const dockerAvailable = await isDockerAvailable();
			if (!dockerAvailable) {
				const fallback = isWebServer ? "none" : "local";
				console.warn(
					`[sandbox] Docker not available. Falling back to ${fallback} sandbox.`,
				);
				return isWebServer ? undefined : new LocalSandbox();
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
				const fallback = isWebServer ? "none" : "local";
				console.warn(`[sandbox] Falling back to ${fallback} sandbox.`);
				return isWebServer ? undefined : new LocalSandbox();
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
