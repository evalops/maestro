import { createSessionHookService } from "../hooks/session-integration.js";
import type { PreCompactHookInput } from "../hooks/types.js";

export interface CompactionHookContext {
	cwd: string;
	sessionId?: string;
	signal?: AbortSignal;
}

export interface CompactionHookResult {
	blocked: boolean;
	blockReason?: string;
	additionalContext?: string;
	systemMessage?: string;
	preventContinuation: boolean;
	stopReason?: string;
}

export interface CompactionHookService {
	hasHooks?(eventType: "PreCompact"): boolean;
	runPreCompactHooks(
		trigger: PreCompactHookInput["trigger"],
		tokenCount: number,
		targetTokenCount: number,
		signal?: AbortSignal,
	): Promise<CompactionHookResult>;
}

export function buildCompactionHookContext(
	sessionManager: { getSessionId?: () => string | undefined },
	cwd: string,
	signal?: AbortSignal,
): CompactionHookContext {
	return {
		cwd,
		sessionId: sessionManager.getSessionId?.() ?? undefined,
		signal,
	};
}

export function createCompactionHookService(
	context: CompactionHookContext,
): CompactionHookService {
	return createSessionHookService({
		cwd: context.cwd,
		sessionId: context.sessionId,
	});
}
