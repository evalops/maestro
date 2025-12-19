/**
 * External Tools Manager
 *
 * This module manages optional external command-line tools that enhance
 * the agent's capabilities. Currently supported tools:
 *
 * - fd: Fast file finder (sharkdp/fd)
 * - rg: Ripgrep for fast content search (BurntSushi/ripgrep)
 *
 * The manager handles:
 * 1. Detection of existing installations (system PATH or local)
 * 2. Automatic download from GitHub releases
 * 3. Platform-specific binary selection (macOS, Linux, Windows)
 * 4. Architecture support (x86_64, arm64)
 *
 * Tools are installed to ~/.composer/tools/ to avoid requiring
 * system-wide permissions or polluting the system PATH.
 */

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	renameSync,
	rmSync,
} from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import chalk from "chalk";
import { PATHS } from "../config/constants.js";

/** Directory where downloaded tools are installed */
const TOOLS_DIR = PATHS.TOOLS_DIR;
const FETCH_TIMEOUT_MS = 30_000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;

/**
 * Configuration for an external tool.
 * Defines how to find, download, and install the tool.
 */
interface ToolConfig {
	/** Human-readable name for display */
	name: string;
	/** GitHub repository in owner/repo format */
	repo: string;
	/** Name of the binary executable */
	binaryName: string;
	/** Prefix for version tags (e.g., "v" for "v1.0.0") */
	tagPrefix: string;
	/** Function to determine the release asset name for a platform */
	getAssetName: (
		version: string,
		plat: string,
		architecture: string,
	) => string | null;
}

/**
 * Registry of supported external tools and their configurations.
 * Each tool defines platform-specific asset name patterns for GitHub releases.
 */
const TOOLS: Record<string, ToolConfig> = {
	// fd: A simple, fast and user-friendly alternative to 'find'
	fd: {
		name: "fd",
		repo: "sharkdp/fd",
		binaryName: "fd",
		tagPrefix: "v",
		getAssetName: (version, plat, architecture) => {
			// Map Node.js arch names to Rust target names
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-apple-darwin.tar.gz`;
			}
			if (plat === "linux") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-unknown-linux-gnu.tar.gz`;
			}
			if (plat === "win32") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-pc-windows-msvc.zip`;
			}
			return null; // Unsupported platform
		},
	},

	// ripgrep: A line-oriented search tool (faster than grep)
	rg: {
		name: "ripgrep",
		repo: "BurntSushi/ripgrep",
		binaryName: "rg",
		tagPrefix: "", // ripgrep uses bare version numbers (e.g., "14.0.0")
		getAssetName: (version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ripgrep-${version}-${archStr}-apple-darwin.tar.gz`;
			}
			if (plat === "linux") {
				// Linux x86_64 uses musl for better compatibility
				if (architecture === "arm64") {
					return `ripgrep-${version}-aarch64-unknown-linux-gnu.tar.gz`;
				}
				return `ripgrep-${version}-x86_64-unknown-linux-musl.tar.gz`;
			}
			if (plat === "win32") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ripgrep-${version}-${archStr}-pc-windows-msvc.zip`;
			}
			return null; // Unsupported platform
		},
	},
};

/**
 * Check if a command exists on the system PATH.
 * Uses --version flag as a safe probe that most tools support.
 */
function commandExists(cmd: string): boolean {
	try {
		const result = spawnSync(cmd, ["--version"], { stdio: "pipe" });
		return result.error === undefined || result.error === null;
	} catch {
		return false;
	}
}

/**
 * Get the path to a tool binary, checking local install first then system PATH.
 *
 * Priority order:
 * 1. Local installation in ~/.composer/tools/
 * 2. System PATH
 *
 * @param tool - The tool identifier ("fd" or "rg")
 * @returns Path to the binary, or null if not found
 */
export function getToolPath(tool: "fd" | "rg"): string | null {
	const config = TOOLS[tool];
	if (!config) return null;

	// Check our tools directory first (preferred - known version)
	const localPath = join(
		TOOLS_DIR,
		config.binaryName + (platform() === "win32" ? ".exe" : ""),
	);
	if (existsSync(localPath)) {
		return localPath;
	}

	// Fall back to system PATH (may be different version)
	if (commandExists(config.binaryName)) {
		return config.binaryName;
	}

	return null;
}

/**
 * Fetch the latest version number from GitHub releases API.
 *
 * @param repo - Repository in owner/repo format
 * @returns Version string (without "v" prefix)
 */
async function fetchWithTimeout(
	url: string,
	init?: RequestInit,
): Promise<{ response: Response; clearTimeout: () => void }> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(url, { ...init, signal: controller.signal });
		return {
			response,
			clearTimeout: () => clearTimeout(timeout),
		};
	} catch (error) {
		clearTimeout(timeout);
		throw error;
	}
}

async function getLatestVersion(repo: string): Promise<string> {
	const { response, clearTimeout: clearFetchTimeout } = await fetchWithTimeout(
		`https://api.github.com/repos/${repo}/releases/latest`,
		{
			headers: { "User-Agent": "composer-coding-agent" },
		},
	);
	try {
		if (!response.ok) {
			throw new Error(`GitHub API error: ${response.status}`);
		}

		const data = (await response.json()) as { tag_name: string };
		// Strip "v" prefix if present for consistent version handling
		return data.tag_name.replace(/^v/, "");
	} finally {
		clearFetchTimeout();
	}
}

/**
 * Download a file from a URL to a local path.
 * Uses streaming to handle large files efficiently.
 */
async function downloadFile(url: string, dest: string): Promise<void> {
	const { response, clearTimeout: clearFetchTimeout } =
		await fetchWithTimeout(url);
	try {
		if (!response.ok) {
			throw new Error(`Failed to download: ${response.status}`);
		}

		if (!response.body) {
			throw new Error("No response body");
		}

		clearFetchTimeout();

		// Stream the response directly to disk
		const stream = Readable.fromWeb(
			response.body as Parameters<typeof Readable.fromWeb>[0],
		);
		const fileStream = createWriteStream(dest);
		let idleTimeoutId: ReturnType<typeof setTimeout> | null = null;

		const clearIdleTimeout = (): void => {
			if (idleTimeoutId) {
				clearTimeout(idleTimeoutId);
				idleTimeoutId = null;
			}
		};

		const resetIdleTimeout = (): void => {
			clearIdleTimeout();
			idleTimeoutId = setTimeout(() => {
				const error = new Error(
					`Tool download idle timeout after ${Math.round(DOWNLOAD_IDLE_TIMEOUT_MS / 1000)}s`,
				);
				stream.destroy();
				fileStream.destroy();
				fileStream.emit("error", error);
			}, DOWNLOAD_IDLE_TIMEOUT_MS);
		};

		const onStreamEnd = (): void => {
			clearIdleTimeout();
		};

		resetIdleTimeout();
		stream.on("data", resetIdleTimeout);
		stream.on("end", onStreamEnd);
		stream.on("close", onStreamEnd);
		stream.on("error", onStreamEnd);

		try {
			await finished(stream.pipe(fileStream));
		} finally {
			stream.off("data", resetIdleTimeout);
			stream.off("end", onStreamEnd);
			stream.off("close", onStreamEnd);
			stream.off("error", onStreamEnd);
			clearIdleTimeout();
		}
	} finally {
		clearFetchTimeout();
	}
}

function runExtractor(
	command: string,
	args: string[],
	description: string,
): void {
	const result = spawnSync(command, args, { stdio: "pipe" });
	if (result.error) {
		throw new Error(`${description} failed: ${result.error.message}`);
	}
	if (result.status !== 0) {
		const stderr = result.stderr?.toString().trim();
		throw new Error(
			`${description} exited with code ${result.status}${
				stderr ? `: ${stderr}` : ""
			}`,
		);
	}
}

function findBinary(root: string, binaryName: string): string | null {
	const stack = [root];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;
		const entries = readdirSync(current, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isSymbolicLink()) {
				continue;
			}
			const entryPath = join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(entryPath);
				continue;
			}
			if (entry.isFile() && entry.name === binaryName) {
				return entryPath;
			}
		}
	}
	return null;
}

/**
 * Download and install a tool from GitHub releases.
 *
 * Process:
 * 1. Fetch latest version from GitHub API
 * 2. Determine platform-specific asset name
 * 3. Download the release archive
 * 4. Extract the binary
 * 5. Move to tools directory and set permissions
 *
 * @param tool - The tool identifier ("fd" or "rg")
 * @returns Path to the installed binary
 */
async function downloadTool(tool: "fd" | "rg"): Promise<string> {
	const config = TOOLS[tool];
	if (!config) throw new Error(`Unknown tool: ${tool}`);

	const plat = platform();
	const architecture = arch();

	// Get the latest version from GitHub
	const version = await getLatestVersion(config.repo);

	// Determine the correct asset for this platform
	const assetName = config.getAssetName(version, plat, architecture);
	if (!assetName) {
		throw new Error(`Unsupported platform: ${plat}/${architecture}`);
	}

	// Ensure tools directory exists
	mkdirSync(TOOLS_DIR, { recursive: true });

	// Build paths
	const downloadUrl = `https://github.com/${config.repo}/releases/download/${config.tagPrefix}${version}/${assetName}`;
	const archivePath = join(TOOLS_DIR, assetName);
	const binaryExt = plat === "win32" ? ".exe" : "";
	const binaryPath = join(TOOLS_DIR, config.binaryName + binaryExt);

	// Download the release archive
	await downloadFile(downloadUrl, archivePath);

	// Create temp directory for extraction
	const extractDir = mkdtempSync(join(TOOLS_DIR, "extract-"));

	try {
		// Extract based on archive type
		if (assetName.endsWith(".tar.gz")) {
			runExtractor(
				"tar",
				["-xzf", archivePath, "-C", extractDir],
				"tar extract",
			);
		} else if (assetName.endsWith(".zip")) {
			runExtractor(
				"unzip",
				["-o", archivePath, "-d", extractDir],
				"unzip extract",
			);
		} else {
			throw new Error(`Unsupported archive format: ${assetName}`);
		}

		const extractedBinary =
			findBinary(extractDir, config.binaryName + binaryExt) ??
			(() => {
				throw new Error(
					`Binary not found in archive: ${config.binaryName}${binaryExt}`,
				);
			})();

		// Move binary to final location
		rmSync(binaryPath, { force: true });
		renameSync(extractedBinary, binaryPath);

		// Make executable on Unix systems
		if (plat !== "win32") {
			chmodSync(binaryPath, 0o755);
		}
	} finally {
		// Clean up downloaded archive and temp directory
		rmSync(archivePath, { force: true });
		rmSync(extractDir, { recursive: true, force: true });
	}

	return binaryPath;
}

/**
 * Ensure a tool is available, downloading it if necessary.
 *
 * This is the main entry point for tool management. It:
 * 1. Checks if the tool already exists (local or system)
 * 2. If not, downloads and installs it
 * 3. Returns the path to use, or null if unavailable
 *
 * @param tool - The tool identifier ("fd" or "rg")
 * @param silent - If true, suppress console output
 * @returns Path to the tool binary, or null if installation failed
 */
export async function ensureTool(
	tool: "fd" | "rg",
	silent = false,
): Promise<string | null> {
	// Check if already installed
	const existingPath = getToolPath(tool);
	if (existingPath) {
		return existingPath;
	}

	const config = TOOLS[tool];
	if (!config) return null;

	// Notify user about download (unless silent)
	if (!silent) {
		console.log(chalk.dim(`${config.name} not found. Downloading...`));
	}

	try {
		const path = await downloadTool(tool);
		if (!silent) {
			console.log(chalk.dim(`${config.name} installed to ${path}`));
		}
		return path;
	} catch (e) {
		// Download failed - log and return null (tool is optional)
		if (!silent) {
			console.log(
				chalk.yellow(
					`Failed to download ${config.name}: ${e instanceof Error ? e.message : e}`,
				),
			);
		}
		return null;
	}
}
