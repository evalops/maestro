/**
 * Plan Mode Persistence System
 *
 * Provides file-based persistence for plan mode state, similar to Claude Code's
 * plan file path tracking. The plan file path is stored in a session-specific
 * location and can be resumed across sessions.
 *
 * Environment variables:
 * - COMPOSER_PLAN_FILE: Override the default plan file path
 * - COMPOSER_PLAN_DIR: Override the directory for plan files (default: .composer/plans)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("plan-mode");

/**
 * Plan mode state that persists across sessions.
 */
export interface PlanModeState {
	/** Whether plan mode is currently active */
	active: boolean;
	/** Path to the current plan file */
	filePath: string;
	/** Session ID that created this plan */
	sessionId?: string;
	/** Git branch when plan was created */
	gitBranch?: string;
	/** Git commit SHA when plan was created */
	gitCommitSha?: string;
	/** When the plan was created */
	createdAt: string;
	/** When the plan was last updated */
	updatedAt: string;
	/** Custom plan name/description */
	name?: string;
}

/**
 * Configuration for plan mode.
 */
export interface PlanModeConfig {
	/** Base directory for plan files */
	planDir: string;
	/** File to store plan mode state */
	stateFile: string;
}

const DEFAULT_CONFIG: PlanModeConfig = {
	planDir: join(process.cwd(), ".composer", "plans"),
	stateFile: join(homedir(), ".composer", "plan-state.json"),
};

/**
 * Get plan mode configuration from environment.
 */
export function getPlanModeConfig(): PlanModeConfig {
	const planDir =
		process.env.COMPOSER_PLAN_DIR || join(process.cwd(), ".composer", "plans");
	const stateFile = join(homedir(), ".composer", "plan-state.json");

	return {
		planDir,
		stateFile,
	};
}

/**
 * Ensure the plan directory exists.
 */
function ensurePlanDir(config: PlanModeConfig): void {
	if (!existsSync(config.planDir)) {
		mkdirSync(config.planDir, { recursive: true });
	}
}

/**
 * Generate a plan file path for a new plan.
 */
export function generatePlanFilePath(
	config: PlanModeConfig = getPlanModeConfig(),
	name?: string,
): string {
	ensurePlanDir(config);

	// Use environment variable if set
	if (process.env.COMPOSER_PLAN_FILE) {
		return process.env.COMPOSER_PLAN_FILE;
	}

	// Generate a unique filename based on timestamp and optional name
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const safeName = name
		? name
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.slice(0, 50)
		: "plan";

	return join(config.planDir, `${safeName}-${timestamp}.md`);
}

/**
 * Load the current plan mode state.
 */
export function loadPlanModeState(
	config: PlanModeConfig = getPlanModeConfig(),
): PlanModeState | null {
	try {
		if (!existsSync(config.stateFile)) {
			return null;
		}
		const raw = readFileSync(config.stateFile, "utf-8");
		return JSON.parse(raw) as PlanModeState;
	} catch (err) {
		logger.warn("Failed to load plan mode state", {
			reason: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

/**
 * Save plan mode state.
 */
export function savePlanModeState(
	state: PlanModeState,
	config: PlanModeConfig = getPlanModeConfig(),
): void {
	try {
		const dir = dirname(config.stateFile);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(config.stateFile, JSON.stringify(state, null, 2));
		logger.info("Plan mode state saved", { filePath: state.filePath });
	} catch (err) {
		logger.error(
			"Failed to save plan mode state",
			err instanceof Error ? err : new Error(String(err)),
		);
	}
}

/**
 * Clear plan mode state.
 */
export function clearPlanModeState(
	config: PlanModeConfig = getPlanModeConfig(),
): void {
	try {
		if (existsSync(config.stateFile)) {
			const state = loadPlanModeState(config);
			if (state) {
				state.active = false;
				state.updatedAt = new Date().toISOString();
				writeFileSync(config.stateFile, JSON.stringify(state, null, 2));
			}
		}
		logger.info("Plan mode state cleared");
	} catch (err) {
		logger.warn("Failed to clear plan mode state", {
			reason: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Enter plan mode with a new or existing plan file.
 */
export function enterPlanMode(options: {
	sessionId?: string;
	gitBranch?: string;
	gitCommitSha?: string;
	name?: string;
	filePath?: string;
	config?: PlanModeConfig;
}): PlanModeState {
	const config = options.config || getPlanModeConfig();
	const now = new Date().toISOString();

	// Check for existing active plan
	const existingState = loadPlanModeState(config);
	if (existingState?.active && !options.filePath) {
		// Resume existing plan
		existingState.updatedAt = now;
		if (options.sessionId) {
			existingState.sessionId = options.sessionId;
		}
		savePlanModeState(existingState, config);
		logger.info("Resumed existing plan mode", {
			filePath: existingState.filePath,
		});
		return existingState;
	}

	// Create new plan
	const filePath =
		options.filePath || generatePlanFilePath(config, options.name);

	const state: PlanModeState = {
		active: true,
		filePath,
		sessionId: options.sessionId,
		gitBranch: options.gitBranch,
		gitCommitSha: options.gitCommitSha,
		createdAt: now,
		updatedAt: now,
		name: options.name,
	};

	// Create empty plan file if it doesn't exist
	if (!existsSync(filePath)) {
		const dir = dirname(filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		const header = options.name
			? `# Plan: ${options.name}\n\nCreated: ${now}\n\n## Tasks\n\n`
			: `# Implementation Plan\n\nCreated: ${now}\n\n## Tasks\n\n`;
		writeFileSync(filePath, header);
	}

	savePlanModeState(state, config);
	logger.info("Entered plan mode", { filePath, name: options.name });

	return state;
}

/**
 * Exit plan mode.
 */
export function exitPlanMode(
	config: PlanModeConfig = getPlanModeConfig(),
): PlanModeState | null {
	const state = loadPlanModeState(config);
	if (!state) {
		return null;
	}

	state.active = false;
	state.updatedAt = new Date().toISOString();
	savePlanModeState(state, config);
	logger.info("Exited plan mode", { filePath: state.filePath });

	return state;
}

/**
 * Check if plan mode is currently active.
 */
export function isPlanModeActive(
	config: PlanModeConfig = getPlanModeConfig(),
): boolean {
	const state = loadPlanModeState(config);
	return state?.active ?? false;
}

/**
 * Get the current plan file path if plan mode is active.
 */
export function getCurrentPlanFilePath(
	config: PlanModeConfig = getPlanModeConfig(),
): string | null {
	const state = loadPlanModeState(config);
	return state?.active ? state.filePath : null;
}

/**
 * Read the current plan file content.
 */
export function readPlanFile(
	config: PlanModeConfig = getPlanModeConfig(),
): string | null {
	const filePath = getCurrentPlanFilePath(config);
	if (!filePath || !existsSync(filePath)) {
		return null;
	}

	try {
		return readFileSync(filePath, "utf-8");
	} catch (err) {
		logger.warn("Failed to read plan file", {
			reason: err instanceof Error ? err.message : String(err),
			filePath,
		});
		return null;
	}
}

/**
 * Write content to the current plan file.
 */
export function writePlanFile(
	content: string,
	config: PlanModeConfig = getPlanModeConfig(),
): boolean {
	const state = loadPlanModeState(config);
	if (!state?.active) {
		logger.warn("Cannot write plan file: plan mode not active");
		return false;
	}

	try {
		const dir = dirname(state.filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(state.filePath, content);

		// Update state timestamp
		state.updatedAt = new Date().toISOString();
		savePlanModeState(state, config);

		logger.info("Plan file updated", { filePath: state.filePath });
		return true;
	} catch (err) {
		logger.error(
			"Failed to write plan file",
			err instanceof Error ? err : new Error(String(err)),
		);
		return false;
	}
}

/**
 * Append content to the current plan file.
 */
export function appendToPlanFile(
	content: string,
	config: PlanModeConfig = getPlanModeConfig(),
): boolean {
	const existing = readPlanFile(config);
	if (existing === null) {
		return false;
	}
	return writePlanFile(existing + content, config);
}

/**
 * List all plan files in the plan directory.
 */
export function listPlanFiles(
	config: PlanModeConfig = getPlanModeConfig(),
): string[] {
	try {
		if (!existsSync(config.planDir)) {
			return [];
		}
		const { readdirSync } = require("node:fs") as typeof import("node:fs");
		return readdirSync(config.planDir)
			.filter((f: string) => f.endsWith(".md"))
			.map((f: string) => join(config.planDir, f));
	} catch (err) {
		logger.warn("Failed to list plan files", {
			reason: err instanceof Error ? err.message : String(err),
		});
		return [];
	}
}
