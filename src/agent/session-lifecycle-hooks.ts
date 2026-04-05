import { createSessionHookService } from "../hooks/session-integration.js";
import type { SessionEndHookInput } from "../hooks/types.js";
import { createLogger } from "../utils/logger.js";
import type { Agent } from "./agent.js";

const logger = createLogger("session-lifecycle-hooks");

type SessionLifecycleSessionManager = {
	getHeader?: () => { timestamp?: string } | null;
	getSessionId?: () => string | undefined;
};

export function countCompletedTurns(
	messages: Array<{ role?: string }>,
): number {
	return messages.filter((message) => message.role === "assistant").length;
}

export function computeSessionDurationMs(
	sessionManager: SessionLifecycleSessionManager,
	now = Date.now(),
): number {
	const timestamp = sessionManager.getHeader?.()?.timestamp;
	if (!timestamp) {
		return 0;
	}

	const startedAt = Date.parse(timestamp);
	if (!Number.isFinite(startedAt)) {
		return 0;
	}

	return Math.max(0, now - startedAt);
}

export async function applySessionEndHooks(params: {
	agent: Agent;
	sessionManager: SessionLifecycleSessionManager;
	cwd: string;
	reason: SessionEndHookInput["reason"];
	signal?: AbortSignal;
	now?: number;
}): Promise<void> {
	const service = createSessionHookService({
		cwd: params.cwd,
		sessionId: params.sessionManager.getSessionId?.(),
	});
	if (!service.hasHooks("SessionEnd")) {
		return;
	}

	const durationMs = computeSessionDurationMs(
		params.sessionManager,
		params.now ?? Date.now(),
	);
	const turnCount = countCompletedTurns(params.agent.state.messages);

	try {
		const result = await service.runSessionEndHooks(
			params.reason,
			durationMs,
			turnCount,
			params.signal,
		);
		if (
			result.blocked ||
			result.preventContinuation ||
			result.additionalContext ||
			result.initialUserMessage ||
			result.systemMessage
		) {
			logger.warn(
				"SessionEnd hook returned unsupported control or context output; ignoring",
				{
					reason: params.reason,
					blocked: result.blocked,
					preventContinuation: result.preventContinuation,
				},
			);
		}
	} catch (error) {
		logger.warn("SessionEnd hooks failed", {
			reason: params.reason,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
