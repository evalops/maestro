/**
 * Safe Mode - Safety controls for agent operations.
 *
 * This module implements safety guardrails to prevent the agent from making
 * unintended or dangerous changes. Safe mode is designed for production
 * environments where extra caution is required.
 *
 * ## Features
 *
 * 1. **Plan Requirement**: Mutating operations require a plan to be set first.
 *    This ensures the user has reviewed and approved the intended changes.
 *
 * 2. **Custom Validators**: Run shell commands after file changes to verify
 *    correctness (e.g., linters, type checkers, tests).
 *
 * 3. **LSP Diagnostic Blocking**: Block operations when LSP reports errors
 *    above a configurable severity threshold.
 *
 * ## Environment Variables
 *
 * - `MAESTRO_SAFE_MODE`: Set to "1" to enable safe mode
 * - `MAESTRO_SAFE_REQUIRE_PLAN`: Set to "0" to disable plan requirement
 * - `MAESTRO_SAFE_VALIDATORS`: Comma-separated list of validator commands
 * - `MAESTRO_SAFE_LSP_SEVERITY`: Max LSP severity to allow (1=error, 2=warning)
 *
 * ## Usage
 *
 * ```typescript
 * // Check if plan is required before mutating
 * requirePlanCheck("edit"); // Throws if safe mode enabled without plan
 *
 * // Run validators after successful file changes
 * await runValidatorsOnSuccess(["src/foo.ts"], lspDiagnostics);
 * ```
 */

import { exec } from "node:child_process";
import type { ExecException } from "node:child_process";
import { promisify } from "node:util";
import type { LspDiagnostic } from "../lsp/index.js";

const execAsync = promisify(exec);

// Environment variable names for configuration
const SAFE_MODE_ENV = "MAESTRO_SAFE_MODE";
const VALIDATORS_ENV = "MAESTRO_SAFE_VALIDATORS";
const REQUIRE_PLAN_ENV = "MAESTRO_SAFE_REQUIRE_PLAN";

/**
 * Internal state for safe mode configuration.
 * Configured once at startup and can be reconfigured for testing.
 */
type SafeModeState = {
	/** Whether safe mode is globally enabled */
	enabled: boolean;
	/** Whether a plan must be set before mutating operations */
	requirePlan: boolean;
	/** Shell commands to run as validators after file changes */
	validators: string[];
	/** LSP severity threshold (1=error only, 2=include warnings) */
	lspBlockingSeverity: number;
	/** Whether the plan requirement has been satisfied */
	planSatisfied: boolean;
};

/**
 * Result from running a validator command.
 * Captures output for reporting to the user.
 */
export type ValidatorRunResult = {
	/** The command that was executed */
	command: string;
	/** Standard output from the command */
	stdout: string;
	/** Standard error from the command */
	stderr: string;
};

/**
 * Error thrown when a validator fails.
 *
 * Contains the full validator output for debugging and reporting.
 * The agent should present this to the user and suggest fixes.
 */
export class ValidatorError extends Error {
	constructor(
		public readonly result: ValidatorRunResult,
		public readonly originalError?: Error,
	) {
		super(
			`Validator failed (${result.command}). See validator output for details.`,
		);
		this.name = "ValidatorError";
	}
}

/**
 * Module-level safe mode state.
 * Configured once at startup, can be reset for testing.
 */
const state: SafeModeState = {
	enabled: false,
	requirePlan: false,
	validators: [],
	lspBlockingSeverity: 1, // Default: only block on errors
	planSatisfied: false,
};

// Flag to prevent re-configuration after initial setup
let configured = false;

/**
 * Configure safe mode from environment variables.
 *
 * Called automatically at module load. Can be forced to reconfigure
 * for testing by passing force=true.
 *
 * @param force - If true, reconfigure even if already configured
 */
export function configureSafeMode(force = false): void {
	if (configured && !force) {
		return;
	}
	configured = true;

	// Check if safe mode is enabled via environment
	state.enabled = process.env[SAFE_MODE_ENV] === "1";
	state.requirePlan = false;
	state.validators = [];
	state.lspBlockingSeverity = process.env.MAESTRO_SAFE_LSP_SEVERITY
		? Number(process.env.MAESTRO_SAFE_LSP_SEVERITY)
		: 1;
	state.planSatisfied = false;

	// If not enabled, skip further configuration
	if (!state.enabled) {
		return;
	}

	// Plan requirement is enabled by default in safe mode unless explicitly disabled
	state.requirePlan = process.env[REQUIRE_PLAN_ENV] !== "0";

	// Parse comma-separated list of validator commands
	const validatorsRaw = process.env[VALIDATORS_ENV] ?? "";
	state.validators = validatorsRaw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

// Auto-configure on module load
configureSafeMode();

/**
 * Mark the plan requirement as satisfied.
 *
 * Call this when the user has set up a plan (via todo list or plan mode).
 * This allows mutating operations to proceed.
 *
 * @param value - Whether the plan requirement is satisfied
 */
export function setPlanSatisfied(value: boolean): void {
	state.planSatisfied = value;
}

/**
 * Check if a plan is required before executing a tool.
 *
 * Throws an error if safe mode is enabled, plan is required,
 * and no plan has been set. Used by mutating tools (edit, write, bash).
 *
 * @param toolName - Name of the tool for the error message
 * @throws Error if plan check fails
 */
export function requirePlanCheck(toolName: string): void {
	// Skip check if safe mode disabled or plan not required
	if (!state.enabled || !state.requirePlan) {
		return;
	}
	// Skip check if plan has been set
	if (state.planSatisfied) {
		return;
	}
	throw new Error(
		`Safe mode requires a plan before executing ${toolName}. Create or update a todo checklist first.`,
	);
}

/** Extended error type from exec with captured output */
type ExecError = ExecException & { stdout?: string; stderr?: string };

/**
 * A diagnostic that blocks operation due to severity.
 */
type BlockingDiagnostic = {
	file: string;
	message: string;
	range?: LspDiagnostic["range"];
	severity?: number;
};

/**
 * Type guard to check if an error has stdout/stderr captured.
 */
function isExecError(error: unknown): error is ExecError {
	return (
		typeof error === "object" &&
		error !== null &&
		"stdout" in error &&
		"stderr" in error
	);
}

/**
 * Run validators after successful file changes.
 *
 * This function performs two types of validation:
 * 1. LSP diagnostics check - Fails if LSP reports errors above threshold
 * 2. Custom validators - Runs configured shell commands
 *
 * Validators receive the changed paths in MAESTRO_SAFE_CHANGED_PATHS env var
 * (separated by ::) so they can focus on relevant files.
 *
 * @param paths - Array of file paths that were changed
 * @param lspDiagnostics - Optional LSP diagnostics to check
 * @returns Array of successful validator results
 * @throws ValidatorError if any validation fails
 */
export async function runValidatorsOnSuccess(
	paths: string[],
	lspDiagnostics?: Record<string, LspDiagnostic[]>,
): Promise<ValidatorRunResult[]> {
	// Skip validation if safe mode is disabled
	if (!state.enabled) {
		return [];
	}

	const summaries: ValidatorRunResult[] = [];

	// Check LSP diagnostics first (before running expensive validators)
	if (lspDiagnostics) {
		const blocking = findBlockingDiagnostics(lspDiagnostics);
		if (blocking.length > 0) {
			// Format diagnostics as validator output
			const commandLabel = "lsp-diagnostics";
			throw new ValidatorError({
				command: commandLabel,
				stdout: blocking
					.map(
						(entry) =>
							`${entry.file}:${entry.range?.start.line ?? 0}:${entry.range?.start.character ?? 0} ${entry.message}`,
					)
					.join("\n"),
				stderr: "",
			});
		}
	}

	// Skip command validators if none configured
	if (state.validators.length === 0) {
		return summaries;
	}

	// Prepare environment with changed paths for validators
	const env = {
		...process.env,
		MAESTRO_SAFE_CHANGED_PATHS: paths.join("::"),
	};

	// Run each validator command sequentially
	for (const command of state.validators) {
		try {
			const { stdout, stderr } = await execAsync(command, {
				cwd: process.cwd(),
				env,
			});
			summaries.push({ command, stdout, stderr });
		} catch (error) {
			// Capture output from failed command
			if (isExecError(error)) {
				const summary: ValidatorRunResult = {
					command,
					stdout: error.stdout ?? "",
					stderr: error.stderr ?? "",
				};
				throw new ValidatorError(summary, error);
			}
			throw error;
		}
	}

	return summaries;
}

/**
 * Find LSP diagnostics that should block operation.
 *
 * Filters diagnostics by severity threshold configured in state.
 *
 * @param diagnostics - Map of file paths to their diagnostics
 * @returns Array of blocking diagnostics
 */
function findBlockingDiagnostics(
	diagnostics: Record<string, LspDiagnostic[]>,
): BlockingDiagnostic[] {
	const blocking: BlockingDiagnostic[] = [];
	for (const [file, entries] of Object.entries(diagnostics)) {
		for (const diag of entries) {
			// Treat missing severity as non-blocking (infinity)
			const severity = diag.severity ?? Number.POSITIVE_INFINITY;
			// Include if severity is at or below threshold (lower = more severe)
			if (severity <= state.lspBlockingSeverity) {
				blocking.push({
					file,
					message: diag.message,
					range: diag.range,
					severity: diag.severity,
				});
			}
		}
	}
	return blocking;
}

/**
 * Reset safe mode state for testing.
 *
 * Clears all configuration so tests can start fresh.
 */
export function resetSafeModeForTests(): void {
	configured = false;
	state.enabled = false;
	state.requirePlan = false;
	state.validators = [];
	state.planSatisfied = false;
}

/**
 * Check if safe mode is currently enabled.
 *
 * @returns true if safe mode is enabled
 */
export function isSafeModeEnabled(): boolean {
	return state.enabled;
}
