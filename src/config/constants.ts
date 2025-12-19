/**
 * Centralized configuration constants for Composer CLI.
 *
 * This module consolidates magic numbers, default values, and paths
 * to improve maintainability and allow environment-based overrides.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export const getAgentDir = (): string =>
	process.env.COMPOSER_AGENT_DIR ??
	process.env.PLAYWRIGHT_AGENT_DIR ??
	process.env.CODING_AGENT_DIR ??
	join(homedir(), ".composer", "agent");

/**
 * Session management configuration
 */
export const SESSION_CONFIG = {
	/** Number of entries to buffer before flushing to disk */
	WRITE_BATCH_SIZE: Number.parseInt(
		process.env.COMPOSER_SESSION_BATCH_SIZE ?? "25",
		10,
	),
	/** Default session directory path */
	DEFAULT_DIR: (() => {
		return join(getAgentDir(), "sessions");
	})(),
} as const;

/**
 * Tool execution configuration
 */
export const TOOL_CONFIG = {
	/** Default timeout for bash commands (in milliseconds) */
	BASH_DEFAULT_TIMEOUT_MS: Number.parseInt(
		process.env.COMPOSER_BASH_TIMEOUT_MS ?? "90000",
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
	/** Todo store file path */
	TODO_STORE:
		process.env.COMPOSER_TODO_FILE ??
		join(homedir(), ".composer", "todos.json"),
	/** Usage tracking file path */
	USAGE_FILE:
		process.env.COMPOSER_USAGE_FILE ??
		join(homedir(), ".composer", "usage.json"),
	/** Telemetry log file path */
	TELEMETRY_LOG:
		process.env.COMPOSER_TELEMETRY_FILE ??
		join(homedir(), ".composer", "telemetry.log"),
	/** Tool failure log file path */
	TOOL_FAILURE_LOG: join(homedir(), ".composer", "tool-failures.log"),
	/** Background task log directory */
	BACKGROUND_TASK_LOG_DIR: join(homedir(), ".composer", "background-tasks"),
	/** UI state file path */
	UI_STATE_FILE:
		process.env.COMPOSER_UI_STATE ??
		join(homedir(), ".composer", "agent", "ui-state.json"),
	/** Command prefs file path */
	COMMAND_PREFS_FILE:
		process.env.COMPOSER_COMMAND_PREFS ??
		join(homedir(), ".composer", "agent", "command-prefs.json"),
	/** Bash history file path */
	BASH_HISTORY_FILE:
		process.env.COMPOSER_BASH_HISTORY ??
		join(homedir(), ".composer", "bash-history.json"),
	/** Tools install directory */
	TOOLS_DIR: join(homedir(), ".composer", "tools"),
	/** Cost tracking database path */
	COST_DB:
		process.env.COMPOSER_COST_DB ?? join(homedir(), ".composer", "costs.db"),
	/** Agent context files */
	AGENT_CONTEXT_FILES: ["AGENT.md", "CLAUDE.md"] as const,
} as const;

/**
 * API and network configuration
 */
export const API_CONFIG = {
	/** Request timeout for LLM API calls (in milliseconds) */
	REQUEST_TIMEOUT_MS: Number.parseInt(
		process.env.COMPOSER_API_TIMEOUT_MS ?? "120000",
		10,
	),
	/** Telemetry sampling rate (0-1) */
	TELEMETRY_SAMPLE_RATE: Number.parseFloat(
		process.env.COMPOSER_TELEMETRY_SAMPLE ?? "1.0",
	),
} as const;

/**
 * Performance and limits configuration
 */
export const LIMITS = {
	/** Maximum file size to read (in bytes) */
	MAX_FILE_SIZE_BYTES: Number.parseInt(
		process.env.COMPOSER_MAX_FILE_SIZE ?? "10485760", // 10MB
		10,
	),
	/** Maximum number of search results */
	MAX_SEARCH_RESULTS: Number.parseInt(
		process.env.COMPOSER_MAX_SEARCH_RESULTS ?? "1000",
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
	SAFE_MODE: process.env.COMPOSER_SAFE_MODE === "1",
	/** Enable plan mode (ask before mutations via approval) */
	PLAN_MODE: process.env.COMPOSER_PLAN_MODE === "1",
	/** Enable telemetry */
	TELEMETRY_ENABLED: process.env.COMPOSER_TELEMETRY === "true",
	/** Telemetry endpoint URL */
	TELEMETRY_ENDPOINT: process.env.COMPOSER_TELEMETRY_ENDPOINT,
	/** Enable LSP integration */
	LSP_ENABLED: process.env.COMPOSER_LSP_ENABLED !== "0",
	/** Auto-start LSP servers when enabled */
	LSP_AUTOSTART: process.env.COMPOSER_LSP_AUTOSTART === "1",
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
