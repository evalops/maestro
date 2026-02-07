/**
 * Tool Execution
 * Creates the execution promise for a tool call, handling client/server dispatch,
 * audit logging, safety tracking, and hook lifecycle.
 */

import { getErrorMessage, isRetriableError } from "../../errors/index.js";
import type { ToolHookService } from "../../hooks/tool-integration.js";
import { METRICS } from "../../safety/adaptive-thresholds.js";
import type { AdaptiveThresholds } from "../../safety/adaptive-thresholds.js";
import type { SafetyMiddleware } from "../../safety/safety-middleware.js";
import { ToolError } from "../../tools/tool-dsl.js";
import type { Clock } from "../../utils/clock.js";
import { extractRetryHeaders, parseRetryAfter } from "../../utils/retry.js";
import type {
	ToolRetryConfig,
	ToolRetryDecision,
	ToolRetryRequest,
	ToolRetryService,
} from "../tool-retry.js";
import type {
	AgentRunConfig,
	AgentTool,
	AgentToolResult,
	ToolCall,
	ToolResultMessage,
} from "../types.js";
import type {
	ToolExecutionOutcome,
	ToolUpdateQueue,
} from "./tool-update-queue.js";
import {
	type ToolAuditLogger,
	logToolExecutionAudit,
} from "./transport-utils.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolExecutionContext {
	toolCall: ToolCall;
	effectiveToolCall: ToolCall;
	tool: AgentTool;
	validatedArgs: Record<string, unknown>;
	sanitizedExecutionArgs: Record<string, unknown>;
	cfg: AgentRunConfig;
	signal?: AbortSignal;
	// Services
	clock: Clock;
	safetyMiddleware: SafetyMiddleware;
	adaptiveThresholds: AdaptiveThresholds;
	auditLogger?: ToolAuditLogger;
	hookService?: Pick<
		ToolHookService,
		"runPostToolUseHooks" | "runEvalGateHooks" | "runPostToolUseFailureHooks"
	>;
	toolRetryService?: ToolRetryService;
	toolRetryConfig?: ToolRetryConfig;
	// Concurrency
	toolUpdateQueue: ToolUpdateQueue;
	/** Pre-created client tool execution promise (if applicable) */
	clientToolExecPromise?: Promise<{
		content: AgentToolResult["content"];
		isError: boolean;
	}>;
}

const DEFAULT_TOOL_RETRY_CONFIG: Required<ToolRetryConfig> = {
	maxAutoRetries: 1,
	initialDelayMs: 500,
	maxDelayMs: 5_000,
	backoffMultiplier: 2,
};

/** Hard cap on user-prompted retry rounds to prevent infinite loops. */
const MAX_USER_RETRY_ROUNDS = 10;

const RETRYABLE_MESSAGE_SNIPPETS = [
	"timeout",
	"timed out",
	"rate limit",
	"too many requests",
	"temporarily",
	"overloaded",
	"network",
	"econnreset",
	"econnrefused",
	"enotfound",
];

const NON_RETRYABLE_MESSAGE_SNIPPETS = [
	"invalid",
	"validation",
	"not found",
	"no such file",
	"permission",
	"denied",
	"unauthorized",
	"forbidden",
	"syntax",
];

function resolveToolRetryConfig(
	config?: ToolRetryConfig,
): Required<ToolRetryConfig> {
	return {
		maxAutoRetries:
			config?.maxAutoRetries ?? DEFAULT_TOOL_RETRY_CONFIG.maxAutoRetries,
		initialDelayMs:
			config?.initialDelayMs ?? DEFAULT_TOOL_RETRY_CONFIG.initialDelayMs,
		maxDelayMs: config?.maxDelayMs ?? DEFAULT_TOOL_RETRY_CONFIG.maxDelayMs,
		backoffMultiplier:
			config?.backoffMultiplier ?? DEFAULT_TOOL_RETRY_CONFIG.backoffMultiplier,
	};
}

function isRetryableToolError(error: unknown): boolean {
	if (!error) return false;
	if (isRetriableError(error)) return true;
	if (error instanceof ToolError && error.code === "VALIDATION_ERROR") {
		return false;
	}
	if (error instanceof Error && error.name === "AbortError") {
		return false;
	}
	const message =
		error instanceof Error
			? error.message.toLowerCase()
			: String(error).toLowerCase();
	if (
		NON_RETRYABLE_MESSAGE_SNIPPETS.some((snippet) => message.includes(snippet))
	) {
		return false;
	}
	if (RETRYABLE_MESSAGE_SNIPPETS.some((snippet) => message.includes(snippet))) {
		return true;
	}
	return false;
}

function buildToolErrorHints(error: unknown, baseMessage: string): string[] {
	const hints = new Set<string>();
	const lower = baseMessage.toLowerCase();

	if (error instanceof ToolError && error.code === "VALIDATION_ERROR") {
		hints.add("Check the tool arguments for missing or invalid values.");
	}
	if (
		lower.includes("permission") ||
		lower.includes("eacces") ||
		lower.includes("denied")
	) {
		hints.add("Verify file permissions or access rights.");
	}
	if (lower.includes("not found") || lower.includes("no such file")) {
		hints.add("Confirm the target path exists and is spelled correctly.");
	}
	if (lower.includes("timeout") || lower.includes("timed out")) {
		hints.add("Check network connectivity and retry.");
	}
	if (lower.includes("rate limit") || lower.includes("too many requests")) {
		hints.add("Wait briefly before retrying the request.");
	}
	if (
		lower.includes("unauthorized") ||
		lower.includes("forbidden") ||
		lower.includes("api key") ||
		lower.includes("credential")
	) {
		hints.add("Verify API keys or credentials for this provider.");
	}
	if (isRetriableError(error)) {
		hints.add("This looks transient; retrying may succeed.");
	}

	return Array.from(hints);
}

function formatToolErrorMessage(error: unknown): string {
	const baseMessage = getErrorMessage(error);
	const hints = buildToolErrorHints(error, baseMessage);
	if (hints.length === 0) {
		return baseMessage;
	}
	return `${baseMessage}\n\nNext steps:\n${hints
		.map((hint) => `- ${hint}`)
		.join("\n")}`;
}

function buildRetrySummary(errorMessage: string): string {
	const firstLine = errorMessage.split(/\r?\n/)[0]?.trim();
	if (!firstLine) {
		return "Awaiting retry decision";
	}
	const shortened =
		firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
	return `Retry after error: ${shortened}`;
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	if (!signal) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
	if (signal.aborted) {
		const error = new Error("Operation aborted");
		error.name = "AbortError";
		return Promise.reject(error);
	}
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			cleanup();
			const error = new Error("Operation aborted");
			error.name = "AbortError";
			reject(error);
		};
		const cleanup = () => {
			signal.removeEventListener("abort", onAbort);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution Promise Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a promise that executes the tool and returns the outcome.
 * Handles client vs server tool dispatch, audit logging, safety tracking,
 * and hook lifecycle (PostToolUse, EvalGate, PostToolUseFailure).
 */
export function createToolExecutionPromise(
	ctx: ToolExecutionContext,
): Promise<ToolExecutionOutcome> {
	const {
		toolCall,
		effectiveToolCall,
		tool,
		validatedArgs,
		sanitizedExecutionArgs,
		cfg,
		signal,
		clock,
		safetyMiddleware,
		adaptiveThresholds,
		auditLogger,
		hookService,
		toolUpdateQueue,
		clientToolExecPromise,
		toolRetryService,
		toolRetryConfig,
	} = ctx;

	const startTime = clock.now();
	const resolvedRetryConfig = resolveToolRetryConfig(toolRetryConfig);
	const toolHasRetryConfig =
		tool.maxRetries !== undefined ||
		tool.retryDelayMs !== undefined ||
		tool.shouldRetry !== undefined;
	const isClientTool = tool.executionLocation === "client";
	const allowAutoRetries =
		!isClientTool &&
		!toolHasRetryConfig &&
		resolvedRetryConfig.maxAutoRetries > 0;
	const autoMaxAttempts = isClientTool
		? 1
		: toolHasRetryConfig
			? (tool.maxRetries ?? resolvedRetryConfig.maxAutoRetries) + 1
			: allowAutoRetries
				? resolvedRetryConfig.maxAutoRetries + 1
				: 1;
	const retryDelay = toolHasRetryConfig
		? (tool.retryDelayMs ?? resolvedRetryConfig.initialDelayMs)
		: resolvedRetryConfig.initialDelayMs;
	const shouldRetryFn = tool.shouldRetry ?? isRetryableToolError;

	const context = cfg.sandbox ? { sandbox: cfg.sandbox } : undefined;
	const onUpdate = (partialResult: AgentToolResult) => {
		toolUpdateQueue.push({
			type: "tool_execution_update",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: sanitizedExecutionArgs,
			partialResult,
		});
	};

	const executeToolOnce = async (): Promise<AgentToolResult> => {
		if (tool.executionLocation === "client") {
			if (!clientToolExecPromise) {
				throw new Error(
					`Client tool execution service not configured for tool "${tool.name}"`,
				);
			}
			const res = await clientToolExecPromise;
			return {
				content: res.content,
				isError: res.isError,
				details: undefined,
			} as AgentToolResult;
		}
		return tool.execute(toolCall.id, validatedArgs, signal, context, onUpdate);
	};

	const executeWithRetry = async (): Promise<AgentToolResult> => {
		let totalAttempts = 0;
		let userRetryRounds = 0;
		while (userRetryRounds < MAX_USER_RETRY_ROUNDS) {
			let attempt = 0;
			let delayMs = retryDelay;
			let lastError: unknown;

			while (attempt < autoMaxAttempts) {
				attempt += 1;
				totalAttempts += 1;
				try {
					return await executeToolOnce();
				} catch (error: unknown) {
					lastError = error;
					if (signal?.aborted) {
						throw error;
					}
					const retryable = shouldRetryFn(error);
					const isFinalAttempt = attempt >= autoMaxAttempts;
					if (!retryable || isFinalAttempt) {
						break;
					}
					if (toolHasRetryConfig) {
						// Tool-level config: fixed delay
						await sleepWithSignal(retryDelay, signal);
					} else {
						// Transport-level config: exponential backoff
						const retryAfter = parseRetryAfter(extractRetryHeaders(error));
						const delay = Math.min(
							retryAfter ?? delayMs,
							resolvedRetryConfig.maxDelayMs,
						);
						delayMs = retryAfter
							? resolvedRetryConfig.initialDelayMs
							: Math.min(
									delayMs * resolvedRetryConfig.backoffMultiplier,
									resolvedRetryConfig.maxDelayMs,
								);
						await sleepWithSignal(delay, signal);
					}
				}
			}

			if (!lastError) {
				throw new Error("Tool execution failed without an error");
			}
			if (!toolRetryService || !shouldRetryFn(lastError)) {
				throw lastError;
			}
			const errorMessage = getErrorMessage(lastError);
			const request: ToolRetryRequest = {
				id: `${toolCall.id}:retry:${totalAttempts}`,
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				args: sanitizedExecutionArgs,
				errorMessage,
				attempt: totalAttempts,
				summary: buildRetrySummary(errorMessage),
			};
			if (toolRetryService.requiresUserInteraction()) {
				toolUpdateQueue.push({
					type: "tool_retry_required",
					request,
				});
			}
			const decision: ToolRetryDecision =
				await toolRetryService.requestDecision(request, signal);
			if (toolRetryService.requiresUserInteraction()) {
				toolUpdateQueue.push({
					type: "tool_retry_resolved",
					request,
					decision,
				});
			}
			if (decision.action === "retry") {
				if (isClientTool) {
					// Client tools use a pre-created promise that can't be re-executed
					// from the transport layer. Throw so the client can handle re-dispatch.
					throw lastError;
				}
				userRetryRounds += 1;
				continue;
			}
			if (decision.action === "abort") {
				const abortError = new Error(decision.reason ?? "Tool retry aborted");
				abortError.name = "AbortError";
				throw abortError;
			}
			throw lastError;
		}
		throw new Error(
			`Tool "${toolCall.name}" failed after ${MAX_USER_RETRY_ROUNDS} retry rounds`,
		);
	};

	return (async () => {
		try {
			const result = await executeWithRetry();

			await logToolExecutionAudit(
				auditLogger,
				toolCall.name,
				sanitizedExecutionArgs,
				result.isError ? "failure" : "success",
				clock.now() - startTime,
			);

			safetyMiddleware.postExecution(
				toolCall.name,
				validatedArgs,
				!result.isError,
				true,
			);

			adaptiveThresholds.recordObservation(
				METRICS.FAILURE_RATE,
				result.isError ? 1 : 0,
			);

			const toolResultMsg: ToolResultMessage = {
				role: "toolResult" as const,
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				content: result.content,
				details: result.details,
				isError: result.isError || false,
				timestamp: clock.now(),
			};

			if (hookService && !result.isError) {
				const postHookResult = await hookService.runPostToolUseHooks(
					effectiveToolCall,
					toolResultMsg,
					signal,
				);
				if (postHookResult.additionalContext) {
					toolResultMsg.content = [
						...toolResultMsg.content,
						{
							type: "text" as const,
							text: `\n[Hook context]: ${postHookResult.additionalContext}`,
						},
					];
				}
				if (postHookResult.preventContinuation) {
					toolResultMsg.content = [
						...toolResultMsg.content,
						{
							type: "text" as const,
							text: `\n[Hook stop]: ${postHookResult.stopReason ?? "Hook requested stop"}`,
						},
					];
					toolResultMsg.isError = true;
				}
				if (postHookResult.assertions?.length || postHookResult.evaluation) {
					const mergedDetails: Record<string, unknown> =
						toolResultMsg.details && typeof toolResultMsg.details === "object"
							? {
									...(toolResultMsg.details as Record<string, unknown>),
								}
							: {};
					if (postHookResult.evaluation) {
						mergedDetails.evaluation = postHookResult.evaluation;
					}
					if (postHookResult.assertions?.length) {
						mergedDetails.assertions = postHookResult.assertions;
					}
					toolResultMsg.details = mergedDetails as typeof toolResultMsg.details;
				}

				const evalHookResult = await hookService.runEvalGateHooks(
					effectiveToolCall,
					toolResultMsg,
					signal,
				);

				if (evalHookResult.additionalContext) {
					toolResultMsg.content = [
						...toolResultMsg.content,
						{
							type: "text" as const,
							text: `\n[Hook context]: ${evalHookResult.additionalContext}`,
						},
					];
				}

				if (evalHookResult.assertions?.length || evalHookResult.evaluation) {
					const mergedDetails: Record<string, unknown> =
						toolResultMsg.details && typeof toolResultMsg.details === "object"
							? {
									...(toolResultMsg.details as Record<string, unknown>),
								}
							: {};
					if (
						evalHookResult.evaluation &&
						Object.keys(evalHookResult.evaluation).length > 0
					) {
						mergedDetails.evaluation = evalHookResult.evaluation;
					}
					if (evalHookResult.assertions?.length) {
						mergedDetails.assertions = evalHookResult.assertions;
					}
					toolResultMsg.details = mergedDetails as typeof toolResultMsg.details;
				}

				if (evalHookResult.preventContinuation) {
					toolResultMsg.content = [
						...toolResultMsg.content,
						{
							type: "text" as const,
							text: `\n[Hook stop]: ${evalHookResult.stopReason ?? "Hook requested stop"}`,
						},
					];
					toolResultMsg.isError = true;
				}
			}

			return {
				message: toolResultMsg,
				isError: toolResultMsg.isError,
			};
		} catch (error: unknown) {
			if (error instanceof Error && error.name === "AbortError") {
				throw error;
			}
			const baseErrorMessage = getErrorMessage(error);
			const formattedMessage = formatToolErrorMessage(error);

			await logToolExecutionAudit(
				auditLogger,
				toolCall.name,
				safetyMiddleware.sanitizeForLogging(validatedArgs),
				"failure",
				clock.now() - startTime,
				baseErrorMessage,
			);

			safetyMiddleware.postExecution(toolCall.name, validatedArgs, false, true);
			adaptiveThresholds.recordObservation(METRICS.FAILURE_RATE, 1);

			const toolResultMsg: ToolResultMessage = {
				role: "toolResult" as const,
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				content: [
					{
						type: "text" as const,
						text: formattedMessage,
					},
				],
				details: error instanceof ToolError ? error.details : undefined,
				isError: true,
				timestamp: clock.now(),
			};

			if (hookService) {
				const failureHookResult = await hookService.runPostToolUseFailureHooks(
					effectiveToolCall,
					baseErrorMessage,
					signal,
				);
				if (failureHookResult.additionalContext) {
					toolResultMsg.content = [
						...toolResultMsg.content,
						{
							type: "text" as const,
							text: `\n[Hook context]: ${failureHookResult.additionalContext}`,
						},
					];
				}
			}

			return {
				message: toolResultMsg,
				isError: true,
			};
		}
	})();
}
