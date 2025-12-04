/**
 * Tool execution hook integration.
 *
 * Provides a service for running PreToolUse and PostToolUse hooks
 * in the tool execution flow.
 */

import type { ToolCall, ToolResultMessage } from "../agent/types.js";
import { createLogger } from "../utils/logger.js";
import { executeHooks } from "./executor.js";
import type {
	EvalAssertion,
	EvalGateHookInput,
	HookExecutionResult,
	PostToolUseFailureHookInput,
	PostToolUseHookInput,
	PreToolUseHookInput,
} from "./types.js";

const logger = createLogger("hooks:tool-integration");

/**
 * Context for tool hook execution.
 */
export interface ToolHookContext {
	/** Current working directory */
	cwd: string;
	/** Session ID if available */
	sessionId?: string;
}

/**
 * Result from PreToolUse hook processing.
 */
export interface PreToolUseHookResult {
	/** Whether to block the tool execution */
	blocked: boolean;
	/** Reason for blocking */
	blockReason?: string;
	/** Whether to ask for user permission */
	askPermission: boolean;
	/** Updated tool input (if hook modified it) */
	updatedInput?: Record<string, unknown>;
	/** Additional context to inject */
	additionalContext?: string;
	/** System message to inject */
	systemMessage?: string;
	/** Hook execution results for UI display */
	hookResults: HookExecutionResult[];
}

/**
 * Result from PostToolUse hook processing.
 */
export interface PostToolUseHookResult {
	/** Additional context to inject into conversation */
	additionalContext?: string;
	/** Updated tool output (for MCP tools) */
	updatedOutput?: unknown;
	/** System message to inject */
	systemMessage?: string;
	/** Whether to prevent continuation */
	preventContinuation: boolean;
	/** Stop reason if preventing continuation */
	stopReason?: string;
	/** Structured assertions to attach to audit trail */
	assertions?: EvalAssertion[];
	/** Evaluation summary */
	evaluation?: HookEvaluation;
	/** Hook execution results for UI display */
	hookResults: HookExecutionResult[];
}

export interface HookEvaluation {
	score?: number;
	threshold?: number;
	passed?: boolean;
	rationale?: string;
}

/**
 * Service for integrating hooks with tool execution.
 */
export interface ToolHookService {
	/**
	 * Run PreToolUse hooks before tool execution.
	 */
	runPreToolUseHooks(
		toolCall: ToolCall,
		signal?: AbortSignal,
	): Promise<PreToolUseHookResult>;

	/**
	 * Run PostToolUse hooks after successful tool execution.
	 */
	runPostToolUseHooks(
		toolCall: ToolCall,
		result: ToolResultMessage,
		signal?: AbortSignal,
	): Promise<PostToolUseHookResult>;

	/**
	 * Run EvalGate hooks to generate evaluation assertions and scores.
	 */
	runEvalGateHooks(
		toolCall: ToolCall,
		result: ToolResultMessage,
		signal?: AbortSignal,
	): Promise<PostToolUseHookResult>;

	/**
	 * Run PostToolUseFailure hooks after tool execution failure.
	 */
	runPostToolUseFailureHooks(
		toolCall: ToolCall,
		error: string,
		signal?: AbortSignal,
	): Promise<PostToolUseHookResult>;
}

/**
 * Create a ToolHookService instance.
 */
export function createToolHookService(
	context: ToolHookContext,
): ToolHookService {
	return {
		async runPreToolUseHooks(
			toolCall: ToolCall,
			signal?: AbortSignal,
		): Promise<PreToolUseHookResult> {
			const input: PreToolUseHookInput = {
				hook_event_name: "PreToolUse",
				cwd: context.cwd,
				session_id: context.sessionId,
				timestamp: new Date().toISOString(),
				tool_name: toolCall.name,
				tool_call_id: toolCall.id,
				tool_input: toolCall.arguments,
			};

			const results = await executeHooks(input, context.cwd, signal);

			// Process results
			let blocked = false;
			let blockReason: string | undefined;
			let askPermission = false;
			let updatedInput: Record<string, unknown> | undefined;
			let additionalContext: string | undefined;
			let systemMessage: string | undefined;

			for (const result of results) {
				// Check for blocking
				if (result.blockingError) {
					blocked = true;
					blockReason = result.blockingError.blockingError;
					break;
				}

				// Check permission behavior
				if (result.permissionBehavior === "deny") {
					blocked = true;
					blockReason = result.hookPermissionDecisionReason || "Denied by hook";
					break;
				}

				if (result.permissionBehavior === "ask") {
					askPermission = true;
				}

				// Collect updated input (last one wins)
				if (result.updatedInput) {
					updatedInput = result.updatedInput;
				}

				// Collect additional context
				if (result.additionalContext) {
					additionalContext = additionalContext
						? `${additionalContext}\n${result.additionalContext}`
						: result.additionalContext;
				}

				// Collect system message
				if (result.systemMessage) {
					systemMessage = systemMessage
						? `${systemMessage}\n${result.systemMessage}`
						: result.systemMessage;
				}
			}

			logger.debug("PreToolUse hooks completed", {
				toolName: toolCall.name,
				blocked,
				askPermission,
				hasUpdatedInput: Boolean(updatedInput),
				resultCount: results.length,
			});

			return {
				blocked,
				blockReason,
				askPermission,
				updatedInput,
				additionalContext,
				systemMessage,
				hookResults: results,
			};
		},

		async runPostToolUseHooks(
			toolCall: ToolCall,
			result: ToolResultMessage,
			signal?: AbortSignal,
		): Promise<PostToolUseHookResult> {
			// Extract output text for hook input
			const outputText = result.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n")
				.slice(0, 10000); // Truncate large outputs

			const input: PostToolUseHookInput = {
				hook_event_name: "PostToolUse",
				cwd: context.cwd,
				session_id: context.sessionId,
				timestamp: new Date().toISOString(),
				tool_name: toolCall.name,
				tool_call_id: toolCall.id,
				tool_input: toolCall.arguments,
				tool_output: outputText,
				is_error: result.isError,
			};

			const results = await executeHooks(input, context.cwd, signal);

			// Process results
			let additionalContext: string | undefined;
			let updatedOutput: unknown;
			let systemMessage: string | undefined;
			let preventContinuation = false;
			let stopReason: string | undefined;
			let assertions: EvalAssertion[] | undefined;
			let evaluation: HookEvaluation | undefined;

			for (const hookResult of results) {
				// Check for continuation prevention
				if (hookResult.preventContinuation) {
					preventContinuation = true;
					stopReason = hookResult.stopReason;
					break;
				}

				// Collect additional context
				if (hookResult.additionalContext) {
					additionalContext = additionalContext
						? `${additionalContext}\n${hookResult.additionalContext}`
						: hookResult.additionalContext;
				}

				// Collect updated output (last one wins)
				if (hookResult.updatedMCPToolOutput !== undefined) {
					updatedOutput = hookResult.updatedMCPToolOutput;
				}

				// Collect system message
				if (hookResult.systemMessage) {
					systemMessage = systemMessage
						? `${systemMessage}\n${hookResult.systemMessage}`
						: hookResult.systemMessage;
				}

				if (hookResult.assertions?.length) {
					assertions = assertions
						? [...assertions, ...hookResult.assertions]
						: [...hookResult.assertions];
				}

				// Only merge evaluation if it's actually defined and has content
				if (
					hookResult.evaluation &&
					Object.keys(hookResult.evaluation).length > 0
				) {
					evaluation = {
						...evaluation,
						...hookResult.evaluation,
					};
				}
			}

			logger.debug("PostToolUse hooks completed", {
				toolName: toolCall.name,
				preventContinuation,
				hasAssertions: Boolean(assertions?.length),
				hasAdditionalContext: Boolean(additionalContext),
				resultCount: results.length,
			});

			return {
				additionalContext,
				updatedOutput,
				systemMessage,
				preventContinuation,
				stopReason,
				assertions,
				evaluation,
				hookResults: results,
			};
		},

		async runEvalGateHooks(
			toolCall: ToolCall,
			result: ToolResultMessage,
			signal?: AbortSignal,
		): Promise<PostToolUseHookResult> {
			const outputText = result.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n")
				.slice(0, 10000);

			const input: EvalGateHookInput = {
				hook_event_name: "EvalGate",
				cwd: context.cwd,
				session_id: context.sessionId,
				timestamp: new Date().toISOString(),
				tool_name: toolCall.name,
				tool_call_id: toolCall.id,
				tool_input: toolCall.arguments,
				tool_output: outputText,
				is_error: result.isError,
			};

			const results = await executeHooks(input, context.cwd, signal);

			let additionalContext: string | undefined;
			let systemMessage: string | undefined;
			let preventContinuation = false;
			let stopReason: string | undefined;
			let assertions: EvalAssertion[] | undefined;
			let evaluation: HookEvaluation | undefined;

			for (const hookResult of results) {
				if (hookResult.preventContinuation) {
					preventContinuation = true;
					stopReason = hookResult.stopReason;
					break;
				}

				if (hookResult.additionalContext) {
					additionalContext = additionalContext
						? `${additionalContext}\n${hookResult.additionalContext}`
						: hookResult.additionalContext;
				}

				if (hookResult.systemMessage) {
					systemMessage = systemMessage
						? `${systemMessage}\n${hookResult.systemMessage}`
						: hookResult.systemMessage;
				}

				if (hookResult.assertions?.length) {
					assertions = assertions
						? [...assertions, ...hookResult.assertions]
						: [...hookResult.assertions];
				}

				// Only merge evaluation if it's actually defined and has content
				if (
					hookResult.evaluation &&
					Object.keys(hookResult.evaluation).length > 0
				) {
					evaluation = {
						...evaluation,
						...hookResult.evaluation,
					};
				}
			}

			logger.debug("EvalGate hooks completed", {
				toolName: toolCall.name,
				preventContinuation,
				hasAssertions: Boolean(assertions?.length),
				hasEvaluation: Boolean(evaluation),
				resultCount: results.length,
			});

			return {
				additionalContext,
				systemMessage,
				preventContinuation,
				stopReason,
				assertions,
				evaluation,
				hookResults: results,
			};
		},

		async runPostToolUseFailureHooks(
			toolCall: ToolCall,
			error: string,
			signal?: AbortSignal,
		): Promise<PostToolUseHookResult> {
			const input: PostToolUseFailureHookInput = {
				hook_event_name: "PostToolUseFailure",
				cwd: context.cwd,
				session_id: context.sessionId,
				timestamp: new Date().toISOString(),
				tool_name: toolCall.name,
				tool_call_id: toolCall.id,
				tool_input: toolCall.arguments,
				error,
			};

			const results = await executeHooks(input, context.cwd, signal);

			// Process results
			let additionalContext: string | undefined;
			let systemMessage: string | undefined;
			let preventContinuation = false;
			let stopReason: string | undefined;

			for (const hookResult of results) {
				if (hookResult.preventContinuation) {
					preventContinuation = true;
					stopReason = hookResult.stopReason;
					break;
				}

				if (hookResult.additionalContext) {
					additionalContext = additionalContext
						? `${additionalContext}\n${hookResult.additionalContext}`
						: hookResult.additionalContext;
				}

				if (hookResult.systemMessage) {
					systemMessage = systemMessage
						? `${systemMessage}\n${hookResult.systemMessage}`
						: hookResult.systemMessage;
				}
			}

			logger.debug("PostToolUseFailure hooks completed", {
				toolName: toolCall.name,
				preventContinuation,
				resultCount: results.length,
			});

			return {
				additionalContext,
				systemMessage,
				preventContinuation,
				stopReason,
				hookResults: results,
			};
		},
	};
}
