/**
 * Test Verification Hook Integration
 *
 * Integrates the AutoVerifyService with the tool hook system to
 * automatically track file changes and trigger tests at appropriate times.
 *
 * This is NOT a spammy hook - it:
 * - Only tracks changes to relevant code files
 * - Debounces multiple rapid changes
 * - Only runs scoped tests for affected files
 * - Respects cooldown periods
 * - Can be disabled via environment variable
 */

import { isAbsolute, join } from "node:path";
import { registerHook } from "../hooks/config.js";
import type {
	HookCallbackConfig,
	HookInput,
	HookJsonOutput,
	PostToolUseHookInput,
} from "../hooks/types.js";
import { createLogger } from "../utils/logger.js";
import {
	type AutoVerifyConfig,
	type AutoVerifyService,
	type TestResult,
	createAutoVerifyService,
	formatTestResult,
	getAutoVerifyConfig,
	getGlobalAutoVerifyService,
	isTestFile,
	shouldTriggerTests,
} from "./auto-verify.js";

const logger = createLogger("test-verification-hook");

/**
 * Tools that modify files and should trigger test verification.
 */
const FILE_MODIFYING_TOOLS = new Set(["edit", "write", "notebook_edit"]);

/**
 * Extract file path from tool input based on tool type.
 */
function extractFilePath(
	toolName: string,
	toolInput: Record<string, unknown>,
): string | null {
	switch (toolName) {
		case "edit":
			return typeof toolInput.file_path === "string"
				? toolInput.file_path
				: null;
		case "write":
			return typeof toolInput.file_path === "string"
				? toolInput.file_path
				: null;
		case "notebook_edit":
			return typeof toolInput.notebook_path === "string"
				? toolInput.notebook_path
				: null;
		default:
			return null;
	}
}

/**
 * Create the PostToolUse callback hook for test verification.
 */
function createTestVerificationCallback(
	service: AutoVerifyService,
): (input: HookInput) => Promise<HookJsonOutput | null> {
	return async (input: HookInput): Promise<HookJsonOutput | null> => {
		// Only process PostToolUse events
		if (input.hook_event_name !== "PostToolUse") {
			return null;
		}

		const postInput = input as PostToolUseHookInput;

		// Only process file-modifying tools
		if (!FILE_MODIFYING_TOOLS.has(postInput.tool_name)) {
			return null;
		}

		// Skip if tool execution had an error
		if (postInput.is_error) {
			return null;
		}

		// Extract file path from tool input
		const filePath = extractFilePath(postInput.tool_name, postInput.tool_input);
		if (!filePath) {
			return null;
		}

		// Record the file change (this will debounce and eventually trigger tests)
		const absolutePath = isAbsolute(filePath)
			? filePath
			: join(postInput.cwd, filePath);

		logger.debug("Recording file change from tool", {
			tool: postInput.tool_name,
			filePath: absolutePath,
		});

		service.recordFileChange(absolutePath);

		// Return null to not interfere with the hook flow
		// Tests will run asynchronously after debounce period
		return null;
	};
}

/**
 * Options for test verification hook registration.
 */
export interface TestVerificationHookOptions {
	/** Custom configuration */
	config?: Partial<AutoVerifyConfig>;
	/** Callback when tests complete */
	onTestComplete?: (result: TestResult) => void;
}

/**
 * Register test verification hooks.
 *
 * This registers a PostToolUse callback hook that tracks file changes
 * from edit/write tools and triggers debounced test runs.
 *
 * @param cwd - Current working directory for test execution
 * @param options - Configuration options
 * @returns The AutoVerifyService instance for manual control if needed
 */
export function registerTestVerificationHooks(
	cwd: string,
	options: TestVerificationHookOptions = {},
): AutoVerifyService {
	const config = getAutoVerifyConfig();

	// Skip registration if disabled
	if (!config.enabled) {
		logger.info("Test verification disabled, skipping hook registration");
		return getGlobalAutoVerifyService(cwd);
	}

	// Create or get the service
	const service = createAutoVerifyService(cwd, options.config);

	// Set up callback if provided
	if (options.onTestComplete) {
		service.setOnTestComplete(options.onTestComplete);
	}

	// Create the hook config
	const hookConfig: HookCallbackConfig = {
		type: "callback",
		callback: createTestVerificationCallback(service),
	};

	// Register for each file-modifying tool
	for (const toolName of FILE_MODIFYING_TOOLS) {
		registerHook("PostToolUse", hookConfig, toolName);
		logger.debug("Registered test verification hook", { toolName });
	}

	logger.info("Test verification hooks registered", {
		tools: Array.from(FILE_MODIFYING_TOOLS),
		debounceMs: config.debounceDelayMs,
		cooldownMs: config.cooldownMs,
	});

	return service;
}

/**
 * Test verification state for TUI integration.
 */
export interface TestVerificationState {
	/** Whether tests are currently running */
	isRunning: boolean;
	/** Number of pending dirty files */
	pendingFiles: number;
	/** Last test result (if any) */
	lastResult: TestResult | null;
	/** Time of last test run */
	lastRunTime: number | null;
}

/**
 * Create a test verification state tracker.
 *
 * This provides a simple way for the TUI to track test verification state
 * without coupling tightly to the AutoVerifyService internals.
 */
export function createTestVerificationStateTracker(
	service: AutoVerifyService,
): {
	getState(): TestVerificationState;
	destroy(): void;
} {
	let lastResult: TestResult | null = null;
	let lastRunTime: number | null = null;

	// Track test completion
	const originalCallback = service.getConfig();
	service.setOnTestComplete((result) => {
		lastResult = result;
		lastRunTime = Date.now();
	});

	return {
		getState(): TestVerificationState {
			return {
				isRunning: service.isTestRunning(),
				pendingFiles: service.getDirtyFiles().length,
				lastResult,
				lastRunTime,
			};
		},
		destroy(): void {
			// Cleanup if needed
		},
	};
}

/**
 * Format test verification state for display in status bar.
 */
export function formatTestVerificationStatus(
	state: TestVerificationState,
): string | null {
	if (state.isRunning) {
		return "⏳ Running tests...";
	}

	if (state.pendingFiles > 0) {
		return `📝 ${state.pendingFiles} file${state.pendingFiles > 1 ? "s" : ""} changed`;
	}

	if (state.lastResult) {
		if (state.lastResult.success) {
			return `✓ Tests passed (${state.lastResult.passedTests}/${state.lastResult.totalTests})`;
		}
		return `✗ Tests failed (${state.lastResult.failedTests}/${state.lastResult.totalTests})`;
	}

	return null;
}
