/**
 * Plan Mode Persistence System
 *
 * This module provides file-based persistence for plan mode state, enabling
 * users to create, track, and resume implementation plans across sessions.
 * Plan mode is a key feature that helps organize complex multi-step tasks
 * into structured, trackable plans.
 *
 * ## Architecture
 *
 * The plan system uses two types of files:
 * 1. **Plan Files** (.md): Human-readable markdown files containing the actual
 *    plan content, stored in the project's `.maestro/plans/` directory.
 * 2. **State File** (JSON): A single file in the user's home directory that
 *    tracks which plan is currently active and its metadata.
 *
 * ```
 * ~/.maestro/plan-state.json     # Tracks active plan globally
 * project/.maestro/plans/        # Contains plan markdown files
 *   ├── feature-2024-01-15T10-30-00.md
 *   └── refactor-2024-01-16T14-20-00.md
 * ```
 *
 * ## Usage Flow
 *
 * 1. User enters plan mode: `enterPlanMode({ name: "Add auth feature" })`
 * 2. Plan file is created with initial structure
 * 3. Agent can read/append to the plan as work progresses
 * 4. User exits plan mode: `exitPlanMode()`
 * 5. Plan remains on disk for reference, state marked inactive
 *
 * ## Git Integration
 *
 * Plan state optionally captures git context (branch, commit SHA) to help
 * users understand which code state the plan was created against.
 *
 * ## Environment Variables
 *
 * - `MAESTRO_PLAN_FILE`: Override the default plan file path
 * - `MAESTRO_PLAN_DIR`: Override the directory for plan files
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { PATHS } from "../config/constants.js";
import { createLogger } from "../utils/logger.js";
import { resolveEnvPath } from "../utils/path-expansion.js";

// Logger for plan mode operations, useful for debugging state persistence
const logger = createLogger("plan-mode");

/**
 * Plan mode state that persists across sessions.
 *
 * This interface represents the complete state of an active or completed plan,
 * stored in the global state file (~/.maestro/plan-state.json).
 */
export interface PlanModeState {
	/** Whether plan mode is currently active (false = completed/abandoned) */
	active: boolean;
	/** Absolute path to the plan markdown file */
	filePath: string;
	/** Session ID that created this plan (for multi-session tracking) */
	sessionId?: string;
	/** Git branch when plan was created (helps correlate plan to code state) */
	gitBranch?: string;
	/** Git commit SHA when plan was created (pinpoints exact code version) */
	gitCommitSha?: string;
	/** ISO 8601 timestamp when the plan was first created */
	createdAt: string;
	/** ISO 8601 timestamp of the most recent modification */
	updatedAt: string;
	/** Human-readable name/description for the plan */
	name?: string;
}

/**
 * Configuration for plan mode file locations.
 *
 * Allows customization of where plan files and state are stored,
 * useful for testing or multi-project setups.
 */
export interface PlanModeConfig {
	/** Directory where plan markdown files are stored (project-local) */
	planDir: string;
	/** Path to the global state file tracking active plan (user-global) */
	stateFile: string;
}

/**
 * Default configuration used when no overrides are provided.
 * Plans are stored in the current project, state in the user's home dir.
 */
const DEFAULT_CONFIG: PlanModeConfig = {
	planDir: join(process.cwd(), ".maestro", "plans"),
	stateFile: join(PATHS.MAESTRO_HOME, "plan-state.json"),
};

/**
 * Get plan mode configuration from environment.
 *
 * Reads MAESTRO_PLAN_DIR env var to allow custom plan storage location.
 * The state file is always in the user's home directory since it needs
 * to track plans across different projects.
 *
 * @returns Configuration with resolved paths for plan directory and state file
 */
export function getPlanModeConfig(): PlanModeConfig {
	// Allow environment override for plan directory (useful for monorepos)
	const planDir =
		resolveEnvPath(process.env.MAESTRO_PLAN_DIR) ??
		join(process.cwd(), ".maestro", "plans");
	// State file is always user-global to track active plan across projects
	const stateFile = join(PATHS.MAESTRO_HOME, "plan-state.json");

	return {
		planDir,
		stateFile,
	};
}

/**
 * Ensure the plan directory exists, creating it if necessary.
 *
 * Uses recursive creation to handle nested paths like .maestro/plans.
 *
 * @param config - Plan mode configuration with planDir path
 */
function ensurePlanDir(config: PlanModeConfig): void {
	if (!existsSync(config.planDir)) {
		mkdirSync(config.planDir, { recursive: true });
	}
}

/**
 * Generate a plan file path for a new plan.
 *
 * Creates a unique, filesystem-safe filename combining:
 * - Sanitized plan name (lowercase, alphanumeric, hyphens only)
 * - ISO 8601 timestamp (with colons/periods replaced for filesystem safety)
 *
 * @param config - Plan mode configuration
 * @param name - Optional human-readable name for the plan
 * @returns Absolute path to the new plan file
 *
 * @example
 * generatePlanFilePath(config, "Add OAuth")
 * // → "/project/.maestro/plans/add-oauth-2024-01-15T10-30-00-000Z.md"
 */
export function generatePlanFilePath(
	config: PlanModeConfig = getPlanModeConfig(),
	name?: string,
): string {
	ensurePlanDir(config);

	// Environment variable takes precedence (useful for CI/testing)
	if (process.env.MAESTRO_PLAN_FILE) {
		const resolved = resolveEnvPath(process.env.MAESTRO_PLAN_FILE);
		if (resolved) {
			return resolved;
		}
	}

	// Generate a unique filename based on timestamp and optional name
	// Replace colons and periods to make the timestamp filesystem-safe
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	// Sanitize name: lowercase, replace non-alphanumeric with hyphens, truncate
	const safeName = name
		? name
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.slice(0, 50)
		: "plan";

	return join(config.planDir, `${safeName}-${timestamp}.md`);
}

/**
 * Load the current plan mode state from disk.
 *
 * Reads and parses the state file to determine if there's an active plan.
 * Returns null if no state file exists or if parsing fails.
 *
 * @param config - Plan mode configuration
 * @returns The loaded state, or null if no state exists
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
		// Log but don't throw - missing/corrupt state is recoverable
		logger.warn("Failed to load plan mode state", {
			reason: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

/**
 * Save plan mode state to disk.
 *
 * Writes the state as formatted JSON to the state file location.
 * Creates the parent directory if it doesn't exist.
 *
 * @param state - The plan mode state to persist
 * @param config - Plan mode configuration
 */
export function savePlanModeState(
	state: PlanModeState,
	config: PlanModeConfig = getPlanModeConfig(),
): void {
	try {
		// Ensure ~/.maestro directory exists
		const dir = dirname(config.stateFile);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		// Pretty-print JSON for human readability when debugging
		writeFileSync(config.stateFile, JSON.stringify(state, null, 2));
		logger.info("Plan mode state saved", { filePath: state.filePath });
	} catch (err) {
		// Log error but don't crash - state save failure is non-fatal
		logger.error(
			"Failed to save plan mode state",
			err instanceof Error ? err : new Error(String(err)),
		);
	}
}

/**
 * Clear plan mode state (mark current plan as inactive).
 *
 * Unlike deleting the state file, this preserves the plan history
 * by setting active=false. The plan file remains on disk for reference.
 *
 * @param config - Plan mode configuration
 */
export function clearPlanModeState(
	config: PlanModeConfig = getPlanModeConfig(),
): void {
	try {
		if (existsSync(config.stateFile)) {
			const state = loadPlanModeState(config);
			if (state) {
				// Mark inactive rather than deleting - preserves plan history
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
 *
 * This function handles two scenarios:
 * 1. **Resume**: If there's already an active plan and no specific filePath
 *    is provided, it resumes the existing plan (updates timestamp).
 * 2. **Create**: If no active plan exists or a specific filePath is provided,
 *    it creates a new plan with the given options.
 *
 * When creating a new plan, an initial markdown structure is written to the
 * plan file with a header, timestamp, and empty tasks section.
 *
 * @param options - Configuration for entering plan mode:
 *   - sessionId: Current session identifier for tracking
 *   - gitBranch: Current git branch for context
 *   - gitCommitSha: Current commit SHA for pinpointing code state
 *   - name: Human-readable plan name
 *   - filePath: Explicit file path (skips generation, forces new plan)
 *   - config: Custom plan mode configuration
 *
 * @returns The plan mode state (either resumed or newly created)
 *
 * @example
 * // Create a new plan
 * enterPlanMode({ name: "Add user authentication", gitBranch: "feature/auth" })
 *
 * // Resume existing plan (if active)
 * enterPlanMode({ sessionId: "session-123" })
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

	// Check for existing active plan - resume if no explicit filePath given
	const existingState = loadPlanModeState(config);
	if (existingState?.active && !options.filePath) {
		// Resume the existing plan rather than creating a new one
		existingState.updatedAt = now;
		// Allow updating session ID when resuming (new session picks up old plan)
		if (options.sessionId) {
			existingState.sessionId = options.sessionId;
		}
		savePlanModeState(existingState, config);
		logger.info("Resumed existing plan mode", {
			filePath: existingState.filePath,
		});
		return existingState;
	}

	// Create new plan - either forced by filePath or no active plan exists
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

	// Create plan file with initial markdown structure if it doesn't exist
	if (!existsSync(filePath)) {
		const dir = dirname(filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		// Write a markdown template with header and tasks section
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
 * Exit plan mode (deactivate the current plan).
 *
 * Marks the current plan as inactive but preserves the plan file and state
 * history. The plan file remains on disk for future reference.
 *
 * @param config - Plan mode configuration
 * @returns The final state of the plan, or null if no plan was active
 */
export function exitPlanMode(
	config: PlanModeConfig = getPlanModeConfig(),
): PlanModeState | null {
	const state = loadPlanModeState(config);
	if (!state) {
		return null;
	}

	// Mark as inactive - plan file persists for reference
	state.active = false;
	state.updatedAt = new Date().toISOString();
	savePlanModeState(state, config);
	logger.info("Exited plan mode", { filePath: state.filePath });

	return state;
}

/**
 * Check if plan mode is currently active.
 *
 * Quick check useful for conditional behavior based on plan mode status.
 *
 * @param config - Plan mode configuration
 * @returns true if a plan is currently active, false otherwise
 */
export function isPlanModeActive(
	config: PlanModeConfig = getPlanModeConfig(),
): boolean {
	const state = loadPlanModeState(config);
	return state?.active ?? false;
}

/**
 * Get the current plan file path if plan mode is active.
 *
 * Returns the path to read/write plan content when in plan mode.
 *
 * @param config - Plan mode configuration
 * @returns The plan file path if active, null otherwise
 */
export function getCurrentPlanFilePath(
	config: PlanModeConfig = getPlanModeConfig(),
): string | null {
	const state = loadPlanModeState(config);
	return state?.active ? state.filePath : null;
}

function isPathWithinDirectory(
	filePath: string,
	directoryPath: string,
): boolean {
	const normalizedDir = `${resolve(directoryPath)}${sep}`;
	const normalizedFile = resolve(filePath);
	return normalizedFile.startsWith(normalizedDir);
}

/**
 * Get the tracked plan file path for compaction restoration.
 *
 * Active plan files are always eligible. Inactive plan files are only eligible
 * when they still live under the current project's configured plan directory,
 * which avoids restoring stale plans from another workspace.
 */
export function getPlanFilePathForCompactionRestore(
	config: PlanModeConfig = getPlanModeConfig(),
): string | null {
	const state = loadPlanModeState(config);
	if (!state?.filePath) {
		return null;
	}
	if (state.active) {
		return state.filePath;
	}
	return isPathWithinDirectory(state.filePath, config.planDir)
		? state.filePath
		: null;
}

/**
 * Read the current plan file content.
 *
 * Loads the full markdown content of the active plan file.
 * Returns null if plan mode is inactive or file doesn't exist.
 *
 * @param config - Plan mode configuration
 * @returns The plan file contents, or null if unavailable
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
 * Read the tracked plan file content for compaction restoration.
 *
 * Unlike readPlanFile(), this can also read an inactive tracked plan when it
 * still belongs to the current project's plan directory.
 */
export function readPlanFileForCompactionRestore(
	config: PlanModeConfig = getPlanModeConfig(),
): string | null {
	const filePath = getPlanFilePathForCompactionRestore(config);
	if (!filePath || !existsSync(filePath)) {
		return null;
	}

	try {
		return readFileSync(filePath, "utf-8");
	} catch (err) {
		logger.warn("Failed to read tracked plan file for compaction restore", {
			reason: err instanceof Error ? err.message : String(err),
			filePath,
		});
		return null;
	}
}

/**
 * Write content to the current plan file.
 *
 * Replaces the entire plan file content with the provided string.
 * Also updates the state timestamp to track modifications.
 *
 * @param content - The new content for the plan file
 * @param config - Plan mode configuration
 * @returns true if write succeeded, false if plan mode inactive or error
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
		// Ensure directory exists (defensive - should already exist)
		const dir = dirname(state.filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(state.filePath, content);

		// Update state timestamp to track last modification
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
 *
 * Convenience function that reads the existing content and appends new content.
 * Useful for incrementally building up a plan without overwriting.
 *
 * @param content - The content to append
 * @param config - Plan mode configuration
 * @returns true if append succeeded, false if read or write failed
 */
export function appendToPlanFile(
	content: string,
	config: PlanModeConfig = getPlanModeConfig(),
): boolean {
	const existing = readPlanFile(config);
	if (existing === null) {
		return false;
	}
	// Read-modify-write pattern - append new content to existing
	return writePlanFile(existing + content, config);
}

/**
 * List all plan files in the plan directory.
 *
 * Returns all .md files in the plans directory, useful for showing
 * plan history or allowing users to select a previous plan to resume.
 *
 * @param config - Plan mode configuration
 * @returns Array of absolute paths to plan files
 */
export function listPlanFiles(
	config: PlanModeConfig = getPlanModeConfig(),
): string[] {
	try {
		if (!existsSync(config.planDir)) {
			return [];
		}
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

/**
 * Options for exiting plan mode with swarm execution.
 */
export interface ExitPlanModeWithSwarmOptions {
	/** Number of teammates to spawn (1-10) */
	teammateCount: number;
	/** Model to use for teammates (defaults to parent's model) */
	model?: string;
	/** Maximum time per task in milliseconds */
	taskTimeout?: number;
	/** Whether to continue on individual task failures */
	continueOnFailure?: boolean;
	/** Git branch to work on (creates if doesn't exist) */
	gitBranch?: string;
	/** Plan mode configuration override */
	config?: PlanModeConfig;
}

/**
 * Result of swarm execution from plan mode.
 */
export interface SwarmExecutionResult {
	/** Whether the swarm was launched */
	launched: boolean;
	/** Swarm ID if launched */
	swarmId?: string;
	/** Plan state after exiting */
	planState: PlanModeState | null;
	/** Number of tasks extracted from plan */
	taskCount?: number;
	/** Error message if launch failed */
	error?: string;
}

/**
 * Exit plan mode and optionally launch a swarm to implement the plan.
 *
 * This function combines exiting plan mode with launching parallel agents
 * to work on the tasks defined in the plan. Tasks are extracted from the
 * plan file's markdown content (checkbox items, numbered lists, etc.).
 *
 * @param options - Swarm configuration options
 * @returns Result including swarm ID and plan state
 *
 * @example
 * // Exit plan mode and launch 3 teammates to implement
 * const result = await exitPlanModeWithSwarm({
 *   teammateCount: 3,
 *   continueOnFailure: true,
 * });
 * console.log(`Launched swarm ${result.swarmId} with ${result.taskCount} tasks`);
 */
export async function exitPlanModeWithSwarm(
	options: ExitPlanModeWithSwarmOptions,
): Promise<SwarmExecutionResult> {
	const config = options.config || getPlanModeConfig();

	// Get current plan state
	const state = loadPlanModeState(config);
	if (!state?.active) {
		return {
			launched: false,
			planState: null,
			error: "No active plan to implement",
		};
	}

	// Read plan content
	const planContent = readPlanFile(config);
	if (!planContent) {
		return {
			launched: false,
			planState: state,
			error: "Could not read plan file",
		};
	}

	// Dynamically import swarm modules to avoid circular dependencies
	const { parsePlanContent, executeSwarm } = await import("./swarm/index.js");

	// Parse tasks from plan
	const parsed = parsePlanContent(planContent);
	if (parsed.tasks.length === 0) {
		return {
			launched: false,
			planState: state,
			error: "No tasks found in plan file",
		};
	}

	// Exit plan mode (mark as inactive)
	const finalState = exitPlanMode(config);

	// Launch swarm
	try {
		const swarmState = await executeSwarm({
			teammateCount: Math.min(options.teammateCount, parsed.tasks.length),
			planFile: state.filePath,
			tasks: parsed.tasks,
			cwd: process.cwd(),
			parentSessionId: state.sessionId,
			model: options.model,
			taskTimeout: options.taskTimeout,
			continueOnFailure: options.continueOnFailure ?? true,
			gitBranch: options.gitBranch,
		});

		logger.info("Swarm launched from plan mode", {
			swarmId: swarmState.id,
			taskCount: parsed.tasks.length,
			teammateCount: options.teammateCount,
		});

		return {
			launched: true,
			swarmId: swarmState.id,
			planState: finalState,
			taskCount: parsed.tasks.length,
		};
	} catch (error) {
		logger.error(
			"Failed to launch swarm",
			error instanceof Error ? error : new Error(String(error)),
		);
		return {
			launched: false,
			planState: finalState,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
