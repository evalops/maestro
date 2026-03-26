/**
 * Centralized configuration constants for Composer CLI.
 *
 * This module consolidates magic numbers, default values, and paths
 * to improve maintainability and allow environment-based overrides.
 */

import { join, resolve } from "node:path";
import { getHomeDir, resolveEnvPath } from "../utils/path-expansion.js";

export const getComposerHome = (): string =>
	resolveEnvPath(process.env.MAESTRO_HOME) ?? join(getHomeDir(), ".maestro");

export const getAgentDir = (): string => {
	const envAgentDir =
		resolveEnvPath(process.env.MAESTRO_AGENT_DIR) ??
		resolveEnvPath(process.env.PLAYWRIGHT_AGENT_DIR) ??
		resolveEnvPath(process.env.CODING_AGENT_DIR);
	return envAgentDir || join(getComposerHome(), "agent");
};

/** Parse an int env var, returning `fallback` only when the value is NaN. */
function intEnv(raw: string | undefined, fallback: number): number {
	if (raw === undefined) return fallback;
	const n = Number.parseInt(raw, 10);
	return Number.isNaN(n) ? fallback : n;
}

/**
 * Session management configuration
 */
export const SESSION_CONFIG = {
	/** Number of entries to buffer before flushing to disk */
	WRITE_BATCH_SIZE: Number.parseInt(
		process.env.MAESTRO_SESSION_BATCH_SIZE ?? "25",
		10,
	),
	/** Default session directory path */
	get DEFAULT_DIR(): string {
		return (
			resolveEnvPath(process.env.MAESTRO_SESSION_DIR) ??
			join(getAgentDir(), "sessions")
		);
	},
	/** Maximum number of sessions to retain per working directory (0 = unlimited) */
	MAX_SESSIONS: Math.max(0, intEnv(process.env.MAESTRO_MAX_SESSIONS, 100)),
	/** Maximum age for sessions in days (0 = unlimited) */
	MAX_SESSION_AGE_DAYS: Math.max(
		0,
		intEnv(process.env.MAESTRO_MAX_SESSION_AGE_DAYS, 90),
	),
} as const;

/**
 * Tool execution configuration
 */
export const TOOL_CONFIG = {
	/** Default timeout for bash commands (in milliseconds) */
	BASH_DEFAULT_TIMEOUT_MS: Number.parseInt(
		process.env.MAESTRO_BASH_TIMEOUT_MS ?? "90000",
		10,
	),
	/** Default file read limit (lines) */
	READ_DEFAULT_LIMIT: 2400,
	/** Maximum context lines for search results */
	SEARCH_MAX_CONTEXT_LINES: 5,
} as const;

/**
 * Storage paths configuration
 */
export const PATHS = {
	/** Composer home directory */
	get MAESTRO_HOME(): string {
		return getComposerHome();
	},
	/** Todo store file path */
	get TODO_STORE(): string {
		return (
			resolveEnvPath(process.env.MAESTRO_TODO_FILE) ??
			join(getComposerHome(), "todos.json")
		);
	},
	/** Usage tracking file path */
	get USAGE_FILE(): string {
		return (
			resolveEnvPath(process.env.MAESTRO_USAGE_FILE) ??
			join(getComposerHome(), "usage.json")
		);
	},
	/** Telemetry log file path */
	get TELEMETRY_LOG(): string {
		return (
			resolveEnvPath(process.env.MAESTRO_TELEMETRY_FILE) ??
			join(getComposerHome(), "telemetry.log")
		);
	},
	/** Tool failure log file path */
	get TOOL_FAILURE_LOG(): string {
		return join(getComposerHome(), "tool-failures.log");
	},
	/** Background task log directory */
	get BACKGROUND_TASK_LOG_DIR(): string {
		return join(getComposerHome(), "background-tasks");
	},
	/** UI state file path */
	get UI_STATE_FILE(): string {
		return (
			resolveEnvPath(process.env.MAESTRO_UI_STATE) ??
			resolve(getAgentDir(), "ui-state.json")
		);
	},
	/** Command prefs file path */
	get COMMAND_PREFS_FILE(): string {
		return (
			resolveEnvPath(process.env.MAESTRO_COMMAND_PREFS) ??
			resolve(getAgentDir(), "command-prefs.json")
		);
	},
	/** Bash history file path */
	get BASH_HISTORY_FILE(): string {
		return (
			resolveEnvPath(process.env.MAESTRO_BASH_HISTORY) ??
			join(getComposerHome(), "bash-history.json")
		);
	},
	/** Prompt history file path */
	get PROMPT_HISTORY_FILE(): string {
		return (
			resolveEnvPath(process.env.MAESTRO_PROMPT_HISTORY_FILE) ??
			join(getComposerHome(), "history", "prompts.jsonl")
		);
	},
	/** Tool history file path */
	get TOOL_HISTORY_FILE(): string {
		return (
			resolveEnvPath(process.env.MAESTRO_TOOL_HISTORY_FILE) ??
			join(getComposerHome(), "history", "tools.jsonl")
		);
	},
	/** Tools install directory */
	get TOOLS_DIR(): string {
		return join(getComposerHome(), "tools");
	},
	/** Cost tracking database path */
	get COST_DB(): string {
		return (
			resolveEnvPath(process.env.MAESTRO_COST_DB) ??
			join(getComposerHome(), "costs.db")
		);
	},
	/** Agent context files */
	AGENT_CONTEXT_FILES: [
		"AGENTS.override.md",
		"AGENTS.md",
		"AGENT.md",
		"CLAUDE.md",
	] as const,
} as const;

/**
 * API and network configuration
 */
export const API_CONFIG = {
	/** Request timeout for LLM API calls (in milliseconds) */
	REQUEST_TIMEOUT_MS: Number.parseInt(
		process.env.MAESTRO_API_TIMEOUT_MS ?? "120000",
		10,
	),
	/** Telemetry sampling rate (0-1) */
	TELEMETRY_SAMPLE_RATE: Number.parseFloat(
		process.env.MAESTRO_TELEMETRY_SAMPLE ?? "1.0",
	),
} as const;

/**
 * Performance and limits configuration
 */
export const LIMITS = {
	/** Maximum file size to read (in bytes) */
	MAX_FILE_SIZE_BYTES: Number.parseInt(
		process.env.MAESTRO_MAX_FILE_SIZE ?? "10485760", // 10MB
		10,
	),
	/** Maximum number of search results */
	MAX_SEARCH_RESULTS: Number.parseInt(
		process.env.MAESTRO_MAX_SEARCH_RESULTS ?? "1000",
		10,
	),
	/** Maximum command output length (characters) */
	MAX_COMMAND_OUTPUT: 40_000,
	/** Test timeout (milliseconds) */
	TEST_TIMEOUT_MS: 30_000,
} as const;

/**
 * Feature flags and mode toggles
 */
export const FEATURES = {
	/** Enable safe mode (requires plan before mutations) */
	SAFE_MODE: process.env.MAESTRO_SAFE_MODE === "1",
	/** Enable plan mode (ask before mutations via approval) */
	PLAN_MODE: process.env.MAESTRO_PLAN_MODE === "1",
	/** Enable telemetry */
	TELEMETRY_ENABLED: process.env.MAESTRO_TELEMETRY === "true",
	/** Telemetry endpoint URL */
	TELEMETRY_ENDPOINT: process.env.MAESTRO_TELEMETRY_ENDPOINT,
	/** Enable LSP integration */
	LSP_ENABLED: process.env.MAESTRO_LSP_ENABLED !== "0",
	/** Auto-start LSP servers when enabled */
	LSP_AUTOSTART: process.env.MAESTRO_LSP_AUTOSTART === "1",
} as const;

/**
 * Validation helpers
 */
export const VALIDATION = {
	/** File extensions considered safe for reading */
	SAFE_FILE_EXTENSIONS: new Set([
		".ts",
		".js",
		".tsx",
		".jsx",
		".json",
		".md",
		".txt",
		".yml",
		".yaml",
		".toml",
		".xml",
		".html",
		".css",
		".py",
		".go",
		".rs",
		".java",
		".c",
		".cpp",
		".h",
	]),
} as const;

/**
 * Error messages
 */
export const ERRORS = {
	SESSION_WRITE_FAILED: "Failed to write session data",
	SESSION_READ_FAILED: "Failed to read session file",
	TOOL_TIMEOUT: "Tool execution timed out",
	INVALID_PATH: "Invalid or unsafe file path",
	FILE_TOO_LARGE: "File size exceeds maximum allowed limit",
	TOOL_NOT_FOUND: "Requested tool not found",
} as const;
