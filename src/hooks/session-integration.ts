/**
 * Session lifecycle hook integration.
 *
 * Provides a service for running session-level hooks:
 * - SessionStart
 * - SessionEnd
 * - SubagentStart
 * - UserPromptSubmit
 * - PreCompact
 * - Notification
 */

import { createLogger } from "../utils/logger.js";
import { executeHooks, hasHooksForEvent } from "./executor.js";
import type {
	HookExecutionResult,
	NotificationHookInput,
	PreCompactHookInput,
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
	 * Run Notification hooks for various notifications.
	 */
	runNotificationHooks(
		notificationType: string,
		message: string,
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
			| "Notification",
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

		hasHooks(
			eventType:
				| "SessionStart"
				| "SessionEnd"
				| "SubagentStart"
				| "SubagentStop"
				| "UserPromptSubmit"
				| "PreCompact"
				| "Notification",
		): boolean {
			return hasHooksForEvent(eventType, context.cwd);
		},
	};
}
