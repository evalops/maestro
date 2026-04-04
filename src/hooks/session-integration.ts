/**
 * Session lifecycle hook integration.
 *
 * Provides a service for running session-level hooks:
 * - SessionStart
 * - SessionEnd
 * - SubagentStart
 * - SubagentStop
 * - UserPromptSubmit
 * - PreCompact
 * - PostCompact
 * - Notification
 * - Overflow
 * - PreMessage
 * - PostMessage
 * - OnError
 */

import { createLogger } from "../utils/logger.js";
import { executeHooks, hasHooksForEvent } from "./executor.js";
import type {
	HookExecutionResult,
	NotificationHookInput,
	OnErrorHookInput,
	OverflowHookInput,
	PostCompactHookInput,
	PostMessageHookInput,
	PreCompactHookInput,
	PreMessageHookInput,
	SessionEndHookInput,
	SessionStartHookInput,
	SubagentStartHookInput,
	SubagentStopHookInput,
	UserPromptSubmitHookInput,
} from "./types.js";

const logger = createLogger("hooks:session-integration");

/**
 * Context for session hook execution.
 */
export interface SessionHookContext {
	/** Current working directory */
	cwd: string;
	/** Session ID */
	sessionId?: string;
	/** User ID if available */
	userId?: string;
	/** Organization ID if available */
	orgId?: string;
}

/**
 * Result from session lifecycle hook processing.
 */
export interface SessionHookResult {
	/** Whether to block the session/operation */
	blocked: boolean;
	/** Reason for blocking */
	blockReason?: string;
	/** Additional context to inject */
	additionalContext?: string;
	/** System message to inject */
	systemMessage?: string;
	/** Whether to prevent continuation */
	preventContinuation: boolean;
	/** Stop reason if preventing continuation */
	stopReason?: string;
	/** Hook execution results for UI display */
	hookResults: HookExecutionResult[];
}

/**
 * Result from UserPromptSubmit hook processing.
 */
export interface UserPromptHookResult extends SessionHookResult {
	/** Additional context to prepend to the prompt */
	additionalContext?: string;
}

/**
 * Service for integrating hooks with session lifecycle.
 */
export interface SessionHookService {
	/**
	 * Run SessionStart hooks when a session begins.
	 */
	runSessionStartHooks(
		source: string,
		signal?: AbortSignal,
	): Promise<SessionHookResult>;

	/**
	 * Run SessionEnd hooks when a session ends.
	 */
	runSessionEndHooks(
		reason: SessionEndHookInput["reason"],
		durationMs: number,
		turnCount: number,
		signal?: AbortSignal,
	): Promise<SessionHookResult>;

	/**
	 * Run SubagentStart hooks before spawning a subagent.
	 */
	runSubagentStartHooks(
		agentType: string,
		prompt: string,
		parentSessionId?: string,
		signal?: AbortSignal,
	): Promise<SessionHookResult>;

	/**
	 * Run SubagentStop hooks when a subagent completes.
	 */
	runSubagentStopHooks(
		agentType: string,
		agentId: string,
		success: boolean,
		durationMs: number,
		turnCount: number,
		options?: {
			error?: string;
			transcriptPath?: string;
			parentSessionId?: string;
		},
		signal?: AbortSignal,
	): Promise<SessionHookResult>;

	/**
	 * Run UserPromptSubmit hooks when user submits a prompt.
	 */
	runUserPromptSubmitHooks(
		prompt: string,
		attachmentCount: number,
		signal?: AbortSignal,
	): Promise<UserPromptHookResult>;

	/**
	 * Run PreCompact hooks before context compaction.
	 */
	runPreCompactHooks(
		trigger: PreCompactHookInput["trigger"],
		tokenCount: number,
		targetTokenCount: number,
		signal?: AbortSignal,
	): Promise<SessionHookResult>;

	/**
	 * Run PostCompact hooks after context compaction succeeds.
	 */
	runPostCompactHooks(
		trigger: PostCompactHookInput["trigger"],
		compactSummary: string,
		signal?: AbortSignal,
	): Promise<SessionHookResult>;

	/**
	 * Run Notification hooks for various notifications.
	 */
	runNotificationHooks(
		notificationType: string,
		message: string,
		signal?: AbortSignal,
	): Promise<SessionHookResult>;

	/**
	 * Run Overflow hooks when context overflow is detected.
	 */
	runOverflowHooks(
		tokenCount: number,
		maxTokens: number,
		model?: string,
		signal?: AbortSignal,
	): Promise<SessionHookResult>;

	/**
	 * Run PreMessage hooks before sending user message to model.
	 */
	runPreMessageHooks(
		message: string,
		attachments: string[],
		model?: string,
		signal?: AbortSignal,
	): Promise<SessionHookResult>;

	/**
	 * Run PostMessage hooks after assistant response is generated.
	 */
	runPostMessageHooks(
		response: string,
		inputTokens: number,
		outputTokens: number,
		durationMs: number,
		stopReason?: string,
		signal?: AbortSignal,
	): Promise<SessionHookResult>;

	/**
	 * Run OnError hooks when an error occurs.
	 */
	runOnErrorHooks(
		error: string,
		errorKind: string,
		context?: string,
		recoverable?: boolean,
		signal?: AbortSignal,
	): Promise<SessionHookResult>;

	/**
	 * Check if hooks exist for a given event type.
	 */
	hasHooks(
		eventType:
			| "SessionStart"
			| "SessionEnd"
			| "SubagentStart"
			| "SubagentStop"
			| "UserPromptSubmit"
			| "PreCompact"
			| "PostCompact"
			| "Notification"
			| "Overflow"
			| "PreMessage"
			| "PostMessage"
			| "OnError",
	): boolean;
}

/**
 * Process hook execution results into a standardized result.
 */
function processResults(results: HookExecutionResult[]): SessionHookResult {
	let blocked = false;
	let blockReason: string | undefined;
	let additionalContext: string | undefined;
	let systemMessage: string | undefined;
	let preventContinuation = false;
	let stopReason: string | undefined;

	for (const result of results) {
		// Check for blocking
		if (result.blockingError) {
			blocked = true;
			blockReason = result.blockingError.blockingError;
			break;
		}

		// Check for continuation prevention
		if (result.preventContinuation) {
			preventContinuation = true;
			stopReason = result.stopReason;
			break;
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

	return {
		blocked,
		blockReason,
		additionalContext,
		systemMessage,
		preventContinuation,
		stopReason,
		hookResults: results,
	};
}

/**
 * Create a SessionHookService instance.
 */
export function createSessionHookService(
	context: SessionHookContext,
): SessionHookService {
	return {
		async runSessionStartHooks(
			source: string,
			signal?: AbortSignal,
		): Promise<SessionHookResult> {
			const input: SessionStartHookInput = {
				hook_event_name: "SessionStart",
				cwd: context.cwd,
				session_id: context.sessionId,
				timestamp: new Date().toISOString(),
				source,
				user_id: context.userId,
				org_id: context.orgId,
			};

			const results = await executeHooks(input, context.cwd, signal);
			const processed = processResults(results);

			logger.debug("SessionStart hooks completed", {
				source,
				blocked: processed.blocked,
				resultCount: results.length,
			});

			return processed;
		},

		async runSessionEndHooks(
			reason: SessionEndHookInput["reason"],
			durationMs: number,
			turnCount: number,
			signal?: AbortSignal,
		): Promise<SessionHookResult> {
			const input: SessionEndHookInput = {
				hook_event_name: "SessionEnd",
				cwd: context.cwd,
				session_id: context.sessionId,
				timestamp: new Date().toISOString(),
				reason,
				duration_ms: durationMs,
				turn_count: turnCount,
			};

			const results = await executeHooks(input, context.cwd, signal);
			const processed = processResults(results);

			logger.debug("SessionEnd hooks completed", {
				reason,
				durationMs,
				turnCount,
				resultCount: results.length,
			});

			return processed;
		},

		async runSubagentStartHooks(
			agentType: string,
			prompt: string,
			parentSessionId?: string,
			signal?: AbortSignal,
		): Promise<SessionHookResult> {
			const input: SubagentStartHookInput = {
				hook_event_name: "SubagentStart",
				cwd: context.cwd,
				session_id: context.sessionId,
				timestamp: new Date().toISOString(),
				agent_type: agentType,
				prompt,
				parent_session_id: parentSessionId,
			};

			const results = await executeHooks(input, context.cwd, signal);
			const processed = processResults(results);

			logger.debug("SubagentStart hooks completed", {
				agentType,
				blocked: processed.blocked,
				resultCount: results.length,
			});

			return processed;
		},

		async runSubagentStopHooks(
			agentType: string,
			agentId: string,
			success: boolean,
			durationMs: number,
			turnCount: number,
			options?: {
				error?: string;
				transcriptPath?: string;
				parentSessionId?: string;
			},
			signal?: AbortSignal,
		): Promise<SessionHookResult> {
			const input: SubagentStopHookInput = {
				hook_event_name: "SubagentStop",
				cwd: context.cwd,
				session_id: context.sessionId,
				timestamp: new Date().toISOString(),
				agent_type: agentType,
				agent_id: agentId,
				success,
				error: options?.error,
				duration_ms: durationMs,
				turn_count: turnCount,
				transcript_path: options?.transcriptPath,
				parent_session_id: options?.parentSessionId,
			};

			const results = await executeHooks(input, context.cwd, signal);
			const processed = processResults(results);

			logger.debug("SubagentStop hooks completed", {
				agentType,
				agentId,
				success,
				durationMs,
				turnCount,
				resultCount: results.length,
			});

			return processed;
		},

		async runUserPromptSubmitHooks(
			prompt: string,
			attachmentCount: number,
			signal?: AbortSignal,
		): Promise<UserPromptHookResult> {
			const input: UserPromptSubmitHookInput = {
				hook_event_name: "UserPromptSubmit",
				cwd: context.cwd,
				session_id: context.sessionId,
				timestamp: new Date().toISOString(),
				prompt,
				attachment_count: attachmentCount,
			};

			const results = await executeHooks(input, context.cwd, signal);
			const processed = processResults(results);

			logger.debug("UserPromptSubmit hooks completed", {
				promptLength: prompt.length,
				attachmentCount,
				hasAdditionalContext: Boolean(processed.additionalContext),
				resultCount: results.length,
			});

			return processed;
		},

		async runPreCompactHooks(
			trigger: PreCompactHookInput["trigger"],
			tokenCount: number,
			targetTokenCount: number,
			signal?: AbortSignal,
		): Promise<SessionHookResult> {
			const input: PreCompactHookInput = {
				hook_event_name: "PreCompact",
				cwd: context.cwd,
				session_id: context.sessionId,
				timestamp: new Date().toISOString(),
				trigger,
				token_count: tokenCount,
				target_token_count: targetTokenCount,
			};

			const results = await executeHooks(input, context.cwd, signal);
			const processed = processResults(results);

			logger.debug("PreCompact hooks completed", {
				trigger,
				tokenCount,
				targetTokenCount,
				resultCount: results.length,
			});

			return processed;
		},

		async runPostCompactHooks(
			trigger: PostCompactHookInput["trigger"],
			compactSummary: string,
			signal?: AbortSignal,
		): Promise<SessionHookResult> {
			const input: PostCompactHookInput = {
				hook_event_name: "PostCompact",
				cwd: context.cwd,
				session_id: context.sessionId,
				timestamp: new Date().toISOString(),
				trigger,
				compact_summary: compactSummary,
			};

			const results = await executeHooks(input, context.cwd, signal);
			const processed = processResults(results);

			logger.debug("PostCompact hooks completed", {
				trigger,
				summaryLength: compactSummary.length,
				resultCount: results.length,
			});

			return processed;
		},

		async runNotificationHooks(
			notificationType: string,
			message: string,
			signal?: AbortSignal,
		): Promise<SessionHookResult> {
			const input: NotificationHookInput = {
				hook_event_name: "Notification",
				cwd: context.cwd,
				session_id: context.sessionId,
				timestamp: new Date().toISOString(),
				notification_type: notificationType,
				message,
			};

			const results = await executeHooks(input, context.cwd, signal);
			const processed = processResults(results);

			logger.debug("Notification hooks completed", {
				notificationType,
				resultCount: results.length,
			});

			return processed;
		},

		async runOverflowHooks(
			tokenCount: number,
			maxTokens: number,
			model?: string,
			signal?: AbortSignal,
		): Promise<SessionHookResult> {
			const input: OverflowHookInput = {
				hook_event_name: "Overflow",
				cwd: context.cwd,
				session_id: context.sessionId,
				timestamp: new Date().toISOString(),
				token_count: tokenCount,
				max_tokens: maxTokens,
				model,
			};

			const results = await executeHooks(input, context.cwd, signal);
			const processed = processResults(results);

			logger.debug("Overflow hooks completed", {
				tokenCount,
				maxTokens,
				model,
				resultCount: results.length,
			});

			return processed;
		},

		async runPreMessageHooks(
			message: string,
			attachments: string[],
			model?: string,
			signal?: AbortSignal,
		): Promise<SessionHookResult> {
			const input: PreMessageHookInput = {
				hook_event_name: "PreMessage",
				cwd: context.cwd,
				session_id: context.sessionId,
				timestamp: new Date().toISOString(),
				message,
				attachments,
				model,
			};

			const results = await executeHooks(input, context.cwd, signal);
			const processed = processResults(results);

			logger.debug("PreMessage hooks completed", {
				messageLength: message.length,
				attachmentCount: attachments.length,
				model,
				resultCount: results.length,
			});

			return processed;
		},

		async runPostMessageHooks(
			response: string,
			inputTokens: number,
			outputTokens: number,
			durationMs: number,
			stopReason?: string,
			signal?: AbortSignal,
		): Promise<SessionHookResult> {
			const input: PostMessageHookInput = {
				hook_event_name: "PostMessage",
				cwd: context.cwd,
				session_id: context.sessionId,
				timestamp: new Date().toISOString(),
				response,
				input_tokens: inputTokens,
				output_tokens: outputTokens,
				duration_ms: durationMs,
				stop_reason: stopReason,
			};

			const results = await executeHooks(input, context.cwd, signal);
			const processed = processResults(results);

			logger.debug("PostMessage hooks completed", {
				responseLength: response.length,
				inputTokens,
				outputTokens,
				durationMs,
				stopReason,
				resultCount: results.length,
			});

			return processed;
		},

		async runOnErrorHooks(
			error: string,
			errorKind: string,
			errorContext?: string,
			recoverable?: boolean,
			signal?: AbortSignal,
		): Promise<SessionHookResult> {
			const input: OnErrorHookInput = {
				hook_event_name: "OnError",
				cwd: context.cwd,
				session_id: context.sessionId,
				timestamp: new Date().toISOString(),
				error,
				error_kind: errorKind,
				context: errorContext,
				recoverable: recoverable ?? true,
			};

			const results = await executeHooks(input, context.cwd, signal);
			const processed = processResults(results);

			logger.debug("OnError hooks completed", {
				errorKind,
				recoverable,
				resultCount: results.length,
			});

			return processed;
		},

		hasHooks(
			eventType:
				| "SessionStart"
				| "SessionEnd"
				| "SubagentStart"
				| "SubagentStop"
				| "UserPromptSubmit"
				| "PreCompact"
				| "PostCompact"
				| "Notification"
				| "Overflow"
				| "PreMessage"
				| "PostMessage"
				| "OnError",
		): boolean {
			return hasHooksForEvent(eventType, context.cwd);
		},
	};
}
