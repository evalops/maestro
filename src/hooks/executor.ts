/**
 * Hook execution engine.
 *
 * Executes hooks by spawning shell commands, passing hook input as JSON via stdin,
 * and parsing the JSON output for control decisions.
 */

import { spawn } from "node:child_process";
import { createConcurrencyManagerFromEnv } from "../utils/concurrency-manager.js";
import { createLogger } from "../utils/logger.js";
import { AsyncHookTracker } from "./async-hook-tracker.js";
import { getMatchingHooks, loadHookConfiguration } from "./config.js";
import { parseHookOutput } from "./output.js";
import type {
	HookCallbackConfig,
	HookCommandConfig,
	HookCommandResult,
	HookConfig,
	HookEventType,
	HookExecutionResult,
	HookInput,
	HookJsonOutput,
	HookResultMessage,
} from "./types.js";
import { isAsyncHookResponse } from "./types.js";
import {
	executeTypeScriptHooks,
	hasTypeScriptHookHandlers,
} from "./typescript-loader.js";

const logger = createLogger("hooks:executor");

const DEFAULT_HOOK_TIMEOUT_MS = 60_000; // 60 seconds

const hookSlots = createConcurrencyManagerFromEnv(
	"MAESTRO_HOOKS_MAX_CONCURRENCY",
	0,
);

async function acquireHookSlot(): Promise<void> {
	const snapshot = hookSlots.getSnapshot();
	if (hookSlots.isEnabled() && snapshot.active >= snapshot.max) {
		logger.debug("Hook concurrency limit reached; waiting for slot", {
			max: snapshot.max,
			active: snapshot.active,
			queued: snapshot.queued + 1,
		});
	}
	await hookSlots.acquire();
}

function releaseHookSlot(): void {
	hookSlots.release();
}

export function getHookConcurrencySnapshot(): {
	max: number;
	active: number;
	queued: number;
} {
	return hookSlots.getSnapshot();
}

const asyncHookTracker = new AsyncHookTracker();

/**
 * Create a hook result message for UI display.
 */
export function createHookMessage(
	params: Omit<HookResultMessage, "type"> & { type: HookResultMessage["type"] },
): HookResultMessage {
	return {
		type: params.type,
		hookName: params.hookName,
		hookEvent: params.hookEvent,
		toolUseID: params.toolUseID,
		content: params.content,
		blockingError: params.blockingError,
		stdout: params.stdout,
		stderr: params.stderr,
		exitCode: params.exitCode,
	};
}

/**
 * Execute a shell command hook.
 */
async function executeCommandHook(
	hook: HookCommandConfig,
	input: HookInput,
	signal?: AbortSignal,
): Promise<HookCommandResult> {
	// Check if already aborted before spawning process
	if (signal?.aborted) {
		return {
			stdout: "",
			stderr: "Hook aborted before execution",
			status: 130,
			aborted: true,
		};
	}

	const timeoutMs = (hook.timeout ?? 60) * 1000;
	const jsonInput = JSON.stringify(input);

	return new Promise((resolve) => {
		// Build environment, filtering out undefined values to avoid "undefined" strings
		const hookEnv: Record<string, string> = {
			...process.env,
			MAESTRO_PROJECT_DIR: input.cwd,
			MAESTRO_HOOK_EVENT: input.hook_event_name,
		} as Record<string, string>;

		// Only set session ID if defined
		if (input.session_id) {
			hookEnv.MAESTRO_SESSION_ID = input.session_id;
		}

		const child = spawn(hook.command, [], {
			shell: true,
			cwd: input.cwd,
			env: hookEnv,
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let resolved = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const clearHookTimeout = () => {
			if (timeout) {
				clearTimeout(timeout);
				timeout = undefined;
			}
		};

		const cleanup = (reason: "abort" | "timeout") => {
			if (!resolved) {
				resolved = true;
				clearHookTimeout();
				child.kill("SIGTERM");
				if (reason === "abort") {
					resolve({
						stdout,
						stderr: `${stderr}\nHook aborted`,
						status: 130, // Standard interrupt exit code
						aborted: true,
					});
				}
			}
		};

		// Handle abort signal
		let abortListener: (() => void) | undefined;
		if (signal) {
			abortListener = () => cleanup("abort");
			signal.addEventListener("abort", abortListener, { once: true });
		}

		// Timeout handling
		timeout = setTimeout(() => {
			if (!resolved) {
				resolved = true;
				child.kill("SIGTERM");
				if (abortListener && signal) {
					signal.removeEventListener("abort", abortListener);
				}
				resolve({
					stdout,
					stderr: `${stderr}\nHook timed out`,
					status: 124, // Standard timeout exit code
					aborted: true,
				});
			}
		}, timeoutMs);

		child.stdout?.on("data", (data) => {
			stdout += data.toString();

			// Check for async response early
			if (!resolved && stdout.includes("}")) {
				try {
					const parsed = JSON.parse(stdout.trim());
					if (isAsyncHookResponse(parsed)) {
						// Hook is going async, resolve immediately with the response
						resolved = true;
						clearHookTimeout();
						if (abortListener && signal) {
							signal.removeEventListener("abort", abortListener);
						}
						resolve({
							stdout,
							stderr,
							status: 0,
						});
					}
				} catch {
					// Not valid JSON yet, continue collecting
				}
			}
		});

		child.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		child.on("error", (error) => {
			if (!resolved) {
				resolved = true;
				clearHookTimeout();
				if (abortListener && signal) {
					signal.removeEventListener("abort", abortListener);
				}
				resolve({
					stdout,
					stderr: `${stderr}\n${error.message}`,
					status: 1,
				});
			}
		});

		child.on("close", (code) => {
			if (!resolved) {
				resolved = true;
				clearHookTimeout();
				if (abortListener && signal) {
					signal.removeEventListener("abort", abortListener);
				}
				resolve({
					stdout,
					stderr,
					status: code ?? 1,
				});
			}
		});

		// Handle stdin errors (e.g., EPIPE when command doesn't exist)
		child.stdin?.on("error", (err) => {
			// EPIPE is expected when process exits before we finish writing
			if ((err as NodeJS.ErrnoException).code !== "EPIPE") {
				logger.warn("Hook stdin error", {
					error: err.message,
					command: hook.command,
				});
			}
		});

		// Write input to stdin and close it immediately so hooks that read until EOF
		// (e.g. `cat`) don't hang waiting for more input.
		if (!child.stdin) {
			resolved = true;
			clearHookTimeout();
			if (abortListener && signal) {
				signal.removeEventListener("abort", abortListener);
			}
			child.kill("SIGTERM");
			resolve({
				stdout,
				stderr: `${stderr}\nHook stdin unavailable`,
				status: 1,
			});
			return;
		}
		try {
			child.stdin.end(jsonInput);
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			logger.warn("Failed to write to hook stdin", {
				error: error.message,
				command: hook.command,
			});
			try {
				child.stdin.end();
			} catch {
				// ignore
			}
		}
	});
}

/**
 * Execute a callback hook.
 */
async function executeCallbackHook(
	hook: HookCallbackConfig,
	input: HookInput,
): Promise<HookJsonOutput | null> {
	try {
		return await hook.callback(input);
	} catch (error) {
		logger.error(
			"Callback hook threw an error",
			error instanceof Error ? error : new Error(String(error)),
		);
		return null;
	}
}

/**
 * Process the result of a single hook execution.
 */
function processHookResult(
	hookName: string,
	hookEvent: HookEventType,
	result: HookCommandResult,
	toolUseID?: string,
): HookExecutionResult | null {
	// Check for cancellation
	if (result.aborted) {
		return {
			message: createHookMessage({
				type: "hook_cancelled",
				hookName,
				hookEvent,
				toolUseID,
				content: "Hook was cancelled",
			}),
		};
	}

	// Non-zero exit code without output is an error
	if (result.status !== 0 && !result.stdout.trim()) {
		return {
			message: createHookMessage({
				type: "hook_error_during_execution",
				hookName,
				hookEvent,
				toolUseID,
				content: result.stderr || `Hook exited with code ${result.status}`,
				stderr: result.stderr,
				exitCode: result.status,
			}),
		};
	}

	// Try to parse JSON output
	const parsed = parseHookOutput(result.stdout);

	if (!parsed) {
		// No parseable output, but hook succeeded
		if (result.status === 0) {
			return null; // No action needed
		}
		return {
			message: createHookMessage({
				type: "hook_non_blocking_error",
				hookName,
				hookEvent,
				toolUseID,
				content: result.stderr || "Hook produced no valid output",
				stderr: result.stderr,
				exitCode: result.status,
			}),
		};
	}

	// Check for async hook response
	if (isAsyncHookResponse(parsed)) {
		asyncHookTracker.track({
			processId: parsed.processId,
			hookEvent,
			hookName,
			command: hookName,
		});
		logger.debug("Hook running async", {
			processId: parsed.processId,
			hookName,
		});
		return null;
	}

	// Parse the structured JSON output
	return parseStructuredHookOutput(
		parsed as HookJsonOutput,
		hookName,
		hookEvent,
		toolUseID,
		result,
	);
}

/**
 * Parse structured hook JSON output into execution result.
 */
function parseStructuredHookOutput(
	json: HookJsonOutput,
	hookName: string,
	hookEvent: HookEventType,
	toolUseID?: string,
	rawResult?: HookCommandResult,
): HookExecutionResult {
	const result: HookExecutionResult = {
		message: createHookMessage({
			type: "hook_success",
			hookName,
			hookEvent,
			toolUseID,
			stdout: rawResult?.stdout,
			stderr: rawResult?.stderr,
			content:
				rawResult?.stderr && rawResult.stderr.trim().length > 0
					? rawResult.stderr.trim()
					: undefined,
			exitCode: rawResult?.status,
		}),
	};

	// Handle continue: false
	if (json.continue === false) {
		result.preventContinuation = true;
		result.stopReason = json.stopReason;
		result.message = createHookMessage({
			type: "hook_stopped_continuation",
			hookName,
			hookEvent,
			toolUseID,
			content: json.stopReason || "Hook prevented continuation",
		});
	}

	// Handle legacy decision field
	if (json.decision) {
		switch (json.decision) {
			case "approve":
				result.permissionBehavior = "allow";
				break;
			case "block":
				result.permissionBehavior = "deny";
				result.blockingError = {
					blockingError: json.reason || "Blocked by hook",
					command: hookName,
				};
				result.message = createHookMessage({
					type: "hook_blocking_error",
					hookName,
					hookEvent,
					toolUseID,
					blockingError: result.blockingError,
				});
				break;
		}
	}

	// Handle system message
	if (json.systemMessage) {
		result.systemMessage = json.systemMessage;
	}

	// Handle hook-specific output
	if (json.hookSpecificOutput) {
		const specific = json.hookSpecificOutput;
		result.hookSpecificOutput = specific;

		switch (specific.hookEventName) {
			case "PreToolUse":
				if (specific.permissionDecision) {
					switch (specific.permissionDecision) {
						case "allow":
							result.permissionBehavior = "allow";
							break;
						case "deny":
							result.permissionBehavior = "deny";
							result.blockingError = {
								blockingError:
									specific.permissionDecisionReason ||
									json.reason ||
									"Blocked by hook",
								command: hookName,
							};
							result.message = createHookMessage({
								type: "hook_blocking_error",
								hookName,
								hookEvent,
								toolUseID,
								blockingError: result.blockingError,
							});
							break;
						case "ask":
							result.permissionBehavior = "ask";
							break;
					}
				}
				if (specific.permissionDecisionReason) {
					result.hookPermissionDecisionReason =
						specific.permissionDecisionReason;
				}
				if (specific.updatedInput) {
					result.updatedInput = specific.updatedInput;
				}
				break;

			case "PostToolUse":
				if (specific.additionalContext) {
					result.additionalContext = specific.additionalContext;
					result.message = createHookMessage({
						type: "hook_additional_context",
						hookName,
						hookEvent,
						toolUseID,
						content: specific.additionalContext,
					});
				}
				if (specific.updatedMCPToolOutput) {
					result.updatedMCPToolOutput = specific.updatedMCPToolOutput;
				}
				if (specific.assertions?.length) {
					result.assertions = specific.assertions;
					if (result.message.type === "hook_success") {
						result.message = createHookMessage({
							type: "hook_evaluation",
							hookName,
							hookEvent,
							toolUseID,
							content: `Hook reported ${specific.assertions.length} assertion${
								specific.assertions.length === 1 ? "" : "s"
							}`,
						});
					}
				}
				break;

			case "EvalGate":
				if (specific.assertions?.length) {
					result.assertions = specific.assertions;
				}
				if (
					specific.score !== undefined ||
					specific.threshold !== undefined ||
					specific.passed !== undefined ||
					specific.rationale
				) {
					result.evaluation = {};
					if (specific.score !== undefined) {
						result.evaluation.score = specific.score;
					}
					if (specific.threshold !== undefined) {
						result.evaluation.threshold = specific.threshold;
					}
					if (specific.passed !== undefined) {
						result.evaluation.passed = specific.passed;
					}
					if (specific.rationale) {
						result.evaluation.rationale = specific.rationale;
					}
				}

				if (result.assertions || result.evaluation) {
					const parts = [] as string[];
					if (result.evaluation?.score !== undefined) {
						parts.push(`score=${result.evaluation.score}`);
					}
					if (result.evaluation?.threshold !== undefined) {
						parts.push(`threshold=${result.evaluation.threshold}`);
					}
					if (result.evaluation?.passed !== undefined) {
						parts.push(`passed=${result.evaluation.passed}`);
					}
					if (result.assertions?.length) {
						parts.push(
							`${result.assertions.length} assertion${
								result.assertions.length === 1 ? "" : "s"
							}`,
						);
					}

					result.message = createHookMessage({
						type: "hook_evaluation",
						hookName,
						hookEvent,
						toolUseID,
						content: parts.join(", "),
					});
				}
				break;

			case "PostToolUseFailure":
			case "SubagentStart":
			case "PreMessage":
				if (specific.additionalContext) {
					result.additionalContext = specific.additionalContext;
					result.message = createHookMessage({
						type: "hook_additional_context",
						hookName,
						hookEvent,
						toolUseID,
						content: specific.additionalContext,
					});
				}
				break;

			case "SessionStart":
				if (specific.additionalContext) {
					result.additionalContext = specific.additionalContext;
					result.message = createHookMessage({
						type: "hook_additional_context",
						hookName,
						hookEvent,
						toolUseID,
						content: specific.additionalContext,
					});
				}
				if (specific.initialUserMessage) {
					result.initialUserMessage = specific.initialUserMessage;
				}
				break;

			case "UserPromptSubmit":
				result.additionalContext = specific.additionalContext;
				if (specific.additionalContext) {
					result.message = createHookMessage({
						type: "hook_additional_context",
						hookName,
						hookEvent,
						content: specific.additionalContext,
					});
				}
				break;

			case "PermissionRequest":
				if (specific.decision) {
					result.permissionRequestResult = specific.decision;
					result.permissionBehavior =
						specific.decision.behavior === "allow" ? "allow" : "deny";
					if (json.reason) {
						result.hookPermissionDecisionReason = json.reason;
					}
					if (
						specific.decision.behavior === "allow" &&
						specific.decision.updatedInput
					) {
						result.updatedInput = specific.decision.updatedInput;
					}
				}
				break;
		}
	}

	return result;
}

function normalizeTypeScriptHookOutput(
	event: HookEventType,
	output: HookJsonOutput | undefined,
): HookJsonOutput | null {
	if (!output || typeof output !== "object") {
		return null;
	}

	if (
		"continue" in output ||
		"stopReason" in output ||
		"suppressOutput" in output ||
		"decision" in output ||
		"reason" in output ||
		"systemMessage" in output ||
		"permissionDecision" in output ||
		"hookSpecificOutput" in output
	) {
		return output;
	}

	if (event === "SessionBeforeTree") {
		const direct = output as {
			cancel?: boolean;
			summary?: { summary: string; details?: unknown };
		};
		if (direct.cancel !== undefined || direct.summary !== undefined) {
			return {
				hookSpecificOutput: {
					hookEventName: "SessionBeforeTree",
					cancel: direct.cancel,
					summary: direct.summary,
				},
			};
		}
	}

	return null;
}

async function executeLoadedTypeScriptHooks(
	input: HookInput,
): Promise<HookExecutionResult[]> {
	if (!hasTypeScriptHookHandlers(input.hook_event_name)) {
		return [];
	}

	const results: HookExecutionResult[] = [];
	const toolUseID = "tool_call_id" in input ? input.tool_call_id : undefined;
	const outputs = await executeTypeScriptHooks(input.hook_event_name, input);

	for (const { hookPath, output } of outputs) {
		const normalized = normalizeTypeScriptHookOutput(
			input.hook_event_name,
			output,
		);
		if (!normalized) {
			continue;
		}

		const result = parseStructuredHookOutput(
			normalized,
			hookPath,
			input.hook_event_name,
			toolUseID,
		);
		results.push(result);

		if (result.blockingError || result.preventContinuation) {
			break;
		}
	}

	return results;
}

/**
 * Execute a single hook and return the result.
 */
export async function executeHook(
	hook: HookConfig,
	input: HookInput,
	signal?: AbortSignal,
): Promise<HookExecutionResult | null> {
	const hookName =
		hook.type === "command"
			? hook.command
			: hook.type === "prompt"
				? `prompt:${hook.prompt.slice(0, 30)}...`
				: hook.type === "callback"
					? "callback"
					: "unknown";

	try {
		if (hook.type === "command") {
			const result = await executeCommandHook(hook, input, signal);
			return processHookResult(
				hookName,
				input.hook_event_name,
				result,
				"tool_call_id" in input ? input.tool_call_id : undefined,
			);
		}

		if (hook.type === "callback") {
			const output = await executeCallbackHook(hook, input);
			if (!output) {
				return null;
			}
			return parseStructuredHookOutput(output, hookName, input.hook_event_name);
		}

		// Prompt and agent hooks not yet implemented for execution
		logger.warn(`Hook type ${hook.type} not yet implemented for execution`);
		return null;
	} catch (error) {
		logger.error(
			"Hook execution failed",
			error instanceof Error ? error : new Error(String(error)),
			{ hookName, eventType: input.hook_event_name },
		);
		return {
			message: createHookMessage({
				type: "hook_error_during_execution",
				hookName,
				hookEvent: input.hook_event_name,
				content: error instanceof Error ? error.message : String(error),
			}),
		};
	}
}

/**
 * Execute all matching hooks for an event and aggregate results.
 */
export async function executeHooks(
	input: HookInput,
	cwd: string,
	signal?: AbortSignal,
): Promise<HookExecutionResult[]> {
	const config = loadHookConfiguration(cwd);
	const hooks = getMatchingHooks(config, input);
	const hasTypeScriptHooks = hasTypeScriptHookHandlers(input.hook_event_name);

	if (hooks.length === 0 && !hasTypeScriptHooks) {
		return [];
	}

	// Clean up any stale async hook bookkeeping before starting new work
	cleanupAsyncHooks();

	logger.debug("Executing hooks", {
		eventType: input.hook_event_name,
		hookCount: hooks.length,
	});

	const results: HookExecutionResult[] = [];

	for (const hook of hooks) {
		await acquireHookSlot();
		try {
			const result = await executeHook(hook, input, signal);
			if (result) {
				results.push(result);

				// Stop executing more hooks if one blocked or prevented continuation
				if (result.blockingError || result.preventContinuation) {
					break;
				}
			}
		} finally {
			releaseHookSlot();
		}
	}

	if (
		!signal?.aborted &&
		!results.some(
			(result) => result.blockingError || result.preventContinuation,
		)
	) {
		results.push(...(await executeLoadedTypeScriptHooks(input)));
	}

	// Clean up async bookkeeping after execution in case hooks marked themselves async
	cleanupAsyncHooks();

	return results;
}

/**
 * Check if hooks exist for a given event type.
 */
export function hasHooksForEvent(
	eventType: HookEventType,
	cwd: string,
): boolean {
	const config = loadHookConfiguration(cwd);
	const matchers = config[eventType];
	return Boolean(
		(matchers && matchers.length > 0) || hasTypeScriptHookHandlers(eventType),
	);
}

/**
 * Get count of in-progress hook invocations.
 */
export function getAsyncHookCount(): number {
	return asyncHookTracker.getCount();
}

/**
 * Mark an async hook as completed (for future async completion plumbing).
 */
export function markAsyncHookCompleted(processId: string): void {
	if (asyncHookTracker.markCompleted(processId)) {
		logger.debug("Async hook reported complete", { processId });
	}
}

/**
 * Clean up completed async hook processes.
 */
export function cleanupAsyncHooks(): void {
	const { removed, remaining, maxAgeMs } = asyncHookTracker.cleanup();
	if (removed > 0 || remaining > 0) {
		logger.debug("Async hook registry sweep", {
			removed,
			remaining,
			maxAgeMs,
		});
	}
}
