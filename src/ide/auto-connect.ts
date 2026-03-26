/**
 * IDE Auto-Connect System
 *
 * Automatically detects and connects to running IDEs (VS Code, JetBrains, etc.)
 * for enhanced editor integration. Similar to Claude Code's IDE detection.
 *
 * Environment variables:
 * - MAESTRO_IDE_AUTOCONNECT: Enable/disable auto-connect (default: true)
 * - MAESTRO_IDE_SCAN_PORTS: Comma-separated list of ports to scan
 * - MAESTRO_IDE_TIMEOUT: Connection timeout in ms (default: 5000)
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { createLogger } from "../utils/logger.js";
import { getHomeDir } from "../utils/path-expansion.js";

const logger = createLogger("ide-auto-connect");

/**
 * Supported IDE types.
 */
export type IDEType =
	| "vscode"
	| "vscode-insiders"
	| "cursor"
	| "windsurf"
	| "jetbrains-idea"
	| "jetbrains-webstorm"
	| "jetbrains-pycharm"
	| "jetbrains-goland"
	| "jetbrains-rider"
	| "jetbrains-clion"
	| "jetbrains-rubymine"
	| "jetbrains-datagrip"
	| "vim"
	| "neovim"
	| "emacs"
	| "sublime"
	| "zed"
	| "unknown";

/**
 * Information about a detected IDE.
 */
export interface IDEInfo {
	/** IDE type */
	type: IDEType;
	/** Human-readable name */
	name: string;
	/** Version if detected */
	version?: string;
	/** Whether the IDE is running */
	running: boolean;
	/** Port for communication if applicable */
	port?: number;
	/** Path to IDE executable or config */
	path?: string;
	/** Workspace/project root open in IDE */
	workspaceRoot?: string;
	/** Connection method */
	connectionMethod?: "socket" | "http" | "cli" | "none";
}

/**
 * Configuration for IDE auto-connect.
 */
export interface IDEAutoConnectConfig {
	/** Whether auto-connect is enabled */
	enabled: boolean;
	/** Timeout for connection attempts (ms) */
	timeout: number;
	/** Ports to scan for IDE servers */
	scanPorts: number[];
	/** Scan interval for IDE detection (ms) */
	scanInterval: number;
}

const DEFAULT_CONFIG: IDEAutoConnectConfig = {
	enabled: true,
	timeout: 5000,
	scanPorts: [
		// VS Code Remote Server
		8080, 8443,
		// JetBrains Gateway
		8887, 8888,
		// Cursor
		6000, 6001,
		// Zed
		9999,
	],
	scanInterval: 30000, // 30 seconds
};

/**
 * Get IDE auto-connect configuration from environment.
 */
export function getIDEAutoConnectConfig(): IDEAutoConnectConfig {
	const enabled = process.env.MAESTRO_IDE_AUTOCONNECT !== "false";
	const timeout = Number.parseInt(
		process.env.MAESTRO_IDE_TIMEOUT || "5000",
		10,
	);
	const scanPortsEnv = process.env.MAESTRO_IDE_SCAN_PORTS;
	const scanPorts = scanPortsEnv
		? scanPortsEnv
				.split(",")
				.map((p) => Number.parseInt(p.trim(), 10))
				.filter((p) => !Number.isNaN(p))
		: DEFAULT_CONFIG.scanPorts;

	return {
		...DEFAULT_CONFIG,
		enabled,
		timeout: Number.isNaN(timeout) ? DEFAULT_CONFIG.timeout : timeout,
		scanPorts,
	};
}

/**
 * Check if VS Code is running by looking for socket files.
 */
function detectVSCode(): IDEInfo | null {
	const home = getHomeDir();
	const os = platform();

	const vscodeServerDirs = [
		join(home, ".vscode-server"),
		join(home, ".vscode"),
		os === "darwin"
			? join(home, "Library", "Application Support", "Code")
			: join(home, ".config", "Code"),
	];

	for (const dir of vscodeServerDirs) {
		if (existsSync(dir)) {
			// Check for recent activity
			try {
				const files = readdirSync(dir);
				if (files.length > 0) {
					return {
						type: "vscode",
						name: "Visual Studio Code",
						running: true,
						path: dir,
						connectionMethod: "cli",
					};
				}
			} catch {
				// Ignore read errors
			}
		}
	}

	return null;
}

/**
 * Check if VS Code Insiders is running.
 */
function detectVSCodeInsiders(): IDEInfo | null {
	const home = getHomeDir();
	const os = platform();

	const insidersDirs = [
		join(home, ".vscode-server-insiders"),
		os === "darwin"
			? join(home, "Library", "Application Support", "Code - Insiders")
			: join(home, ".config", "Code - Insiders"),
	];

	for (const dir of insidersDirs) {
		if (existsSync(dir)) {
			return {
				type: "vscode-insiders",
				name: "Visual Studio Code Insiders",
				running: true,
				path: dir,
				connectionMethod: "cli",
			};
		}
	}

	return null;
}

/**
 * Check if Cursor is running.
 */
function detectCursor(): IDEInfo | null {
	const home = getHomeDir();
	const os = platform();

	const cursorDirs = [
		os === "darwin"
			? join(home, "Library", "Application Support", "Cursor")
			: join(home, ".config", "Cursor"),
		join(home, ".cursor"),
	];

	for (const dir of cursorDirs) {
		if (existsSync(dir)) {
			return {
				type: "cursor",
				name: "Cursor",
				running: true,
				path: dir,
				connectionMethod: "cli",
			};
		}
	}

	return null;
}

/**
 * Check if Windsurf is running.
 */
function detectWindsurf(): IDEInfo | null {
	const home = getHomeDir();
	const os = platform();

	const windsurfDirs = [
		os === "darwin"
			? join(home, "Library", "Application Support", "Windsurf")
			: join(home, ".config", "Windsurf"),
		join(home, ".windsurf"),
	];

	for (const dir of windsurfDirs) {
		if (existsSync(dir)) {
			return {
				type: "windsurf",
				name: "Windsurf",
				running: true,
				path: dir,
				connectionMethod: "cli",
			};
		}
	}

	return null;
}

/**
 * Check if Zed is running.
 */
function detectZed(): IDEInfo | null {
	const home = getHomeDir();
	const os = platform();

	const zedDirs = [
		os === "darwin"
			? join(home, "Library", "Application Support", "Zed")
			: join(home, ".config", "zed"),
		join(home, ".zed"),
	];

	for (const dir of zedDirs) {
		if (existsSync(dir)) {
			return {
				type: "zed",
				name: "Zed",
				running: true,
				path: dir,
				connectionMethod: "socket",
			};
		}
	}

	return null;
}

/**
 * Detect JetBrains IDEs by looking for config directories.
 */
function detectJetBrainsIDEs(): IDEInfo[] {
	const home = getHomeDir();
	const os = platform();
	const results: IDEInfo[] = [];

	const jetbrainsBase =
		os === "darwin"
			? join(home, "Library", "Application Support", "JetBrains")
			: join(home, ".config", "JetBrains");

	if (!existsSync(jetbrainsBase)) {
		return results;
	}

	const idePatterns: Record<string, { type: IDEType; name: string }> = {
		IntelliJIdea: { type: "jetbrains-idea", name: "IntelliJ IDEA" },
		WebStorm: { type: "jetbrains-webstorm", name: "WebStorm" },
		PyCharm: { type: "jetbrains-pycharm", name: "PyCharm" },
		GoLand: { type: "jetbrains-goland", name: "GoLand" },
		Rider: { type: "jetbrains-rider", name: "Rider" },
		CLion: { type: "jetbrains-clion", name: "CLion" },
		RubyMine: { type: "jetbrains-rubymine", name: "RubyMine" },
		DataGrip: { type: "jetbrains-datagrip", name: "DataGrip" },
	};

	try {
		const dirs = readdirSync(jetbrainsBase);
		for (const dir of dirs) {
			for (const [pattern, info] of Object.entries(idePatterns)) {
				if (dir.startsWith(pattern)) {
					// Extract version from directory name
					const versionMatch = dir.match(/(\d+\.\d+)/);
					results.push({
						type: info.type,
						name: info.name,
						version: versionMatch ? versionMatch[1] : undefined,
						running: true, // Assume running if config exists
						path: join(jetbrainsBase, dir),
						connectionMethod: "http",
					});
				}
			}
		}
	} catch {
		// Ignore read errors
	}

	return results;
}

/**
 * Detect Vim/Neovim.
 */
function detectVim(): IDEInfo[] {
	const home = getHomeDir();
	const results: IDEInfo[] = [];

	// Check for Neovim
	const nvimConfig = join(home, ".config", "nvim");
	if (existsSync(nvimConfig)) {
		results.push({
			type: "neovim",
			name: "Neovim",
			running: false, // Can't easily detect if running
			path: nvimConfig,
			connectionMethod: "none",
		});
	}

	// Check for Vim
	const vimrc = join(home, ".vimrc");
	const vimDir = join(home, ".vim");
	if (existsSync(vimrc) || existsSync(vimDir)) {
		results.push({
			type: "vim",
			name: "Vim",
			running: false,
			path: existsSync(vimDir) ? vimDir : vimrc,
			connectionMethod: "none",
		});
	}

	return results;
}

/**
 * Detect Emacs.
 */
function detectEmacs(): IDEInfo | null {
	const home = getHomeDir();

	const emacsConfigs = [
		join(home, ".emacs.d"),
		join(home, ".emacs"),
		join(home, ".config", "emacs"),
	];

	for (const config of emacsConfigs) {
		if (existsSync(config)) {
			return {
				type: "emacs",
				name: "Emacs",
				running: false,
				path: config,
				connectionMethod: "none",
			};
		}
	}

	return null;
}

/**
 * Detect Sublime Text.
 */
function detectSublime(): IDEInfo | null {
	const home = getHomeDir();
	const os = platform();

	const sublimeDirs = [
		os === "darwin"
			? join(home, "Library", "Application Support", "Sublime Text")
			: join(home, ".config", "sublime-text"),
		os === "darwin"
			? join(home, "Library", "Application Support", "Sublime Text 3")
			: join(home, ".config", "sublime-text-3"),
	];

	for (const dir of sublimeDirs) {
		if (existsSync(dir)) {
			return {
				type: "sublime",
				name: "Sublime Text",
				running: false,
				path: dir,
				connectionMethod: "cli",
			};
		}
	}

	return null;
}

/**
 * Detect all installed/running IDEs.
 */
export function detectIDEs(): IDEInfo[] {
	const results: IDEInfo[] = [];

	// VS Code family
	const vscode = detectVSCode();
	if (vscode) results.push(vscode);

	const insiders = detectVSCodeInsiders();
	if (insiders) results.push(insiders);

	const cursor = detectCursor();
	if (cursor) results.push(cursor);

	const windsurf = detectWindsurf();
	if (windsurf) results.push(windsurf);

	const zed = detectZed();
	if (zed) results.push(zed);

	// JetBrains family
	results.push(...detectJetBrainsIDEs());

	// Terminal editors
	results.push(...detectVim());

	const emacs = detectEmacs();
	if (emacs) results.push(emacs);

	const sublime = detectSublime();
	if (sublime) results.push(sublime);

	logger.info("IDE detection complete", {
		found: results.length,
		types: results.map((r) => r.type),
	});

	return results;
}

/**
 * Get the primary IDE (most likely to be in active use).
 */
export function getPrimaryIDE(): IDEInfo | null {
	const ides = detectIDEs();

	// Priority order: running IDEs with connection methods first
	const priority: IDEType[] = [
		"cursor",
		"windsurf",
		"vscode",
		"vscode-insiders",
		"zed",
		"jetbrains-webstorm",
		"jetbrains-idea",
		"jetbrains-pycharm",
		"jetbrains-goland",
		"sublime",
		"neovim",
		"vim",
		"emacs",
	];

	for (const type of priority) {
		const ide = ides.find((i) => i.type === type && i.running);
		if (ide) return ide;
	}

	// Return first found if none running
	return ides[0] || null;
}

/**
 * IDE auto-connect manager.
 */
export class IDEAutoConnectManager {
	private config: IDEAutoConnectConfig;
	private scanTimer: ReturnType<typeof setInterval> | null = null;
	private connectedIDE: IDEInfo | null = null;
	private onConnect?: (ide: IDEInfo) => void;
	private onDisconnect?: () => void;

	constructor(config?: Partial<IDEAutoConnectConfig>) {
		this.config = { ...getIDEAutoConnectConfig(), ...config };
	}

	/**
	 * Set connection callbacks.
	 */
	setCallbacks(callbacks: {
		onConnect?: (ide: IDEInfo) => void;
		onDisconnect?: () => void;
	}): void {
		this.onConnect = callbacks.onConnect;
		this.onDisconnect = callbacks.onDisconnect;
	}

	/**
	 * Start scanning for IDEs.
	 */
	startScanning(): void {
		if (!this.config.enabled) {
			return;
		}

		// Initial scan
		this.scan();

		// Periodic scanning
		this.scanTimer = setInterval(() => {
			this.scan();
		}, this.config.scanInterval);

		// Don't keep process alive
		if (this.scanTimer.unref) {
			this.scanTimer.unref();
		}

		logger.info("IDE scanning started", {
			interval: this.config.scanInterval,
		});
	}

	/**
	 * Stop scanning for IDEs.
	 */
	stopScanning(): void {
		if (this.scanTimer) {
			clearInterval(this.scanTimer);
			this.scanTimer = null;
		}
		logger.info("IDE scanning stopped");
	}

	/**
	 * Perform a single scan for IDEs.
	 */
	scan(): IDEInfo[] {
		const ides = detectIDEs();

		// Check if primary IDE changed
		const primary = getPrimaryIDE();
		if (primary && !this.connectedIDE) {
			this.connectedIDE = primary;
			logger.info("Connected to IDE", { type: primary.type });
			this.onConnect?.(primary);
		} else if (!primary && this.connectedIDE) {
			this.connectedIDE = null;
			logger.info("Disconnected from IDE");
			this.onDisconnect?.();
		} else if (
			primary &&
			this.connectedIDE &&
			primary.type !== this.connectedIDE.type
		) {
			this.connectedIDE = primary;
			logger.info("Switched IDE", { type: primary.type });
			this.onConnect?.(primary);
		}

		return ides;
	}

	/**
	 * Get the currently connected IDE.
	 */
	getConnectedIDE(): IDEInfo | null {
		return this.connectedIDE;
	}

	/**
	 * Get all detected IDEs.
	 */
	getDetectedIDEs(): IDEInfo[] {
		return detectIDEs();
	}

	/**
	 * Force reconnection to a specific IDE.
	 */
	connectTo(type: IDEType): IDEInfo | null {
		const ides = detectIDEs();
		const ide = ides.find((i) => i.type === type);

		if (ide) {
			this.connectedIDE = ide;
			logger.info("Manually connected to IDE", { type });
			this.onConnect?.(ide);
		}

		return ide || null;
	}

	/**
	 * Disconnect from current IDE.
	 */
	disconnect(): void {
		if (this.connectedIDE) {
			this.connectedIDE = null;
			logger.info("Manually disconnected from IDE");
			this.onDisconnect?.();
		}
	}
}

/**
 * Create a default IDE auto-connect manager.
 */
export function createIDEAutoConnectManager(
	config?: Partial<IDEAutoConnectConfig>,
): IDEAutoConnectManager {
	return new IDEAutoConnectManager(config);
}
