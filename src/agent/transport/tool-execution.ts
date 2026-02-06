/**
 * Tool Execution
 * Creates the execution promise for a tool call, handling client/server dispatch,
 * audit logging, safety tracking, and hook lifecycle.
 */

import type { ToolHookService } from "../../hooks/tool-integration.js";
import { METRICS } from "../../safety/adaptive-thresholds.js";
import type { AdaptiveThresholds } from "../../safety/adaptive-thresholds.js";
import type { SafetyMiddleware } from "../../safety/safety-middleware.js";
import { ToolError } from "../../tools/tool-dsl.js";
import type { Clock } from "../../utils/clock.js";
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
	// Concurrency
	toolUpdateQueue: ToolUpdateQueue;
	/** Pre-created client tool execution promise (if applicable) */
	clientToolExecPromise?: Promise<{
		content: AgentToolResult["content"];
		isError: boolean;
	}>;
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
	} = ctx;

	const startTime = clock.now();

	return Promise.resolve()
		.then(() => {
			if (tool.executionLocation === "client") {
				if (!clientToolExecPromise) {
					throw new Error(
						`Client tool execution service not configured for tool "${tool.name}"`,
					);
				}
				return clientToolExecPromise.then(
					(res) =>
						({
							content: res.content,
							isError: res.isError,
							details: undefined,
						}) as AgentToolResult,
				);
			}
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
			return tool.execute(
				toolCall.id,
				validatedArgs,
				signal,
				context,
				onUpdate,
			);
		})
		.then(async (result) => {
			// Log tool execution
			await logToolExecutionAudit(
				auditLogger,
				toolCall.name,
				sanitizedExecutionArgs,
				result.isError ? "failure" : "success",
				clock.now() - startTime,
			);

			// Record execution in safety middleware for sequence analysis
			safetyMiddleware.postExecution(
				toolCall.name,
				validatedArgs,
				!result.isError,
				true, // approved
			);

			// Track failure rate for adaptive thresholds
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

			// Run PostToolUse hooks for successful execution
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
		})
		.catch(async (error: unknown) => {
			const errorMessage =
				error instanceof Error ? error.message : `Error: ${String(error)}`;

			await logToolExecutionAudit(
				auditLogger,
				toolCall.name,
				safetyMiddleware.sanitizeForLogging(validatedArgs),
				"failure",
				clock.now() - startTime,
				errorMessage,
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
						text: errorMessage,
					},
				],
				details: error instanceof ToolError ? error.details : undefined,
				isError: true,
				timestamp: clock.now(),
			};

			if (hookService) {
				const failureHookResult = await hookService.runPostToolUseFailureHooks(
					effectiveToolCall,
					errorMessage,
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
		});
}
