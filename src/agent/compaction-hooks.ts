import { createSessionHookService } from "../hooks/session-integration.js";
import type {
	PostCompactHookInput,
	PreCompactHookInput,
} from "../hooks/types.js";

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
	hasHooks?(eventType: "PreCompact" | "PostCompact"): boolean;
	runPreCompactHooks(
		trigger: PreCompactHookInput["trigger"],
		tokenCount: number,
		targetTokenCount: number,
		signal?: AbortSignal,
	): Promise<CompactionHookResult>;
	runPostCompactHooks?(
		trigger: PostCompactHookInput["trigger"],
		compactSummary: string,
		signal?: AbortSignal,
	): Promise<CompactionHookResult>;
}

export interface OverflowHookService {
	hasHooks?(eventType: "Overflow"): boolean;
	runOverflowHooks(
		tokenCount: number,
		maxTokens: number,
		model?: string,
		signal?: AbortSignal,
	): Promise<CompactionHookResult>;
}

export interface StopFailureHookService {
	hasHooks?(eventType: "StopFailure"): boolean;
	runStopFailureHooks(
		error: string,
		errorDetails?: string,
		lastAssistantMessage?: string,
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

export function createOverflowHookService(
	context: CompactionHookContext,
): OverflowHookService {
	return createSessionHookService({
		cwd: context.cwd,
		sessionId: context.sessionId,
	});
}

export function createStopFailureHookService(
	context: CompactionHookContext,
): StopFailureHookService {
	return createSessionHookService({
		cwd: context.cwd,
		sessionId: context.sessionId,
	});
}
