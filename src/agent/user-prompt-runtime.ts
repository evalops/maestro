import { createSessionHookService } from "../hooks/session-integration.js";
import { createLogger } from "../utils/logger.js";
import type { Agent } from "./agent.js";
import { buildCompactionHookContext } from "./compaction-hooks.js";
import { createHookMessage } from "./custom-messages.js";
import {
	type PromptRecoveryCallbacks,
	type RunWithPromptRecoveryOptions,
	runWithPromptRecovery,
} from "./prompt-recovery.js";
import type { HookMessage, UserMessage } from "./types.js";

type PromptRuntimeSessionManager =
	RunWithPromptRecoveryOptions["sessionManager"] & {
		getSessionId?: () => string | undefined;
	};

const logger = createLogger("prompt-runtime-hooks");

function buildSessionStartHookContextMessage(text: string): HookMessage {
	return createHookMessage(
		"SessionStart",
		text,
		true,
		undefined,
		new Date().toISOString(),
	);
}

function buildSessionStartInitialUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: text,
		timestamp: Date.now(),
	};
}

function buildSessionStartHookSystemGuidance(text: string): string {
	return `SessionStart hook system guidance:\n${text}`;
}

function buildUserPromptHookContextMessage(text: string): HookMessage {
	return createHookMessage(
		"UserPromptSubmit",
		text,
		true,
		undefined,
		new Date().toISOString(),
	);
}

function buildUserPromptHookSystemGuidance(text: string): string {
	return `UserPromptSubmit hook system guidance:\n${text}`;
}

export async function applySessionStartHooks(params: {
	agent: Agent;
	sessionManager: PromptRuntimeSessionManager;
	cwd: string;
	source: string;
	signal?: AbortSignal;
}): Promise<void> {
	const service = createSessionHookService({
		cwd: params.cwd,
		sessionId: params.sessionManager.getSessionId?.(),
	});
	if (!service.hasHooks("SessionStart")) {
		return;
	}

	const result = await service.runSessionStartHooks(
		params.source,
		params.signal,
	);
	if (result.blocked || result.preventContinuation) {
		logger.warn(
			"SessionStart hook attempted to stop session startup; ignoring control flow request",
			{
				source: params.source,
				blocked: result.blocked,
				preventContinuation: result.preventContinuation,
				reason: result.blockReason ?? result.stopReason,
			},
		);
	}

	const systemMessage = result.systemMessage?.trim();
	if (systemMessage) {
		params.agent.queueNextRunSystemPromptAddition(
			buildSessionStartHookSystemGuidance(systemMessage),
		);
	}

	const additionalContext = result.additionalContext?.trim();
	if (additionalContext) {
		params.agent.queueNextRunHistoryMessage(
			buildSessionStartHookContextMessage(additionalContext),
		);
	}

	const initialUserMessage = result.initialUserMessage?.trim();
	if (initialUserMessage) {
		params.agent.queueNextRunHistoryMessage(
			buildSessionStartInitialUserMessage(initialUserMessage),
		);
	}
}

export async function applyUserPromptSubmitHooks(params: {
	agent: Agent;
	sessionManager: PromptRuntimeSessionManager;
	cwd: string;
	prompt: string;
	attachmentCount?: number;
	signal?: AbortSignal;
}): Promise<void> {
	const service = createSessionHookService({
		cwd: params.cwd,
		sessionId: params.sessionManager.getSessionId?.(),
	});
	if (!service.hasHooks("UserPromptSubmit")) {
		return;
	}

	const result = await service.runUserPromptSubmitHooks(
		params.prompt,
		params.attachmentCount ?? 0,
		params.signal,
	);
	if (result.blocked) {
		throw new Error(
			result.blockReason ?? "UserPromptSubmit hook blocked this prompt.",
		);
	}
	if (result.preventContinuation) {
		throw new Error(
			result.stopReason ?? "UserPromptSubmit hook stopped this prompt.",
		);
	}

	const systemMessage = result.systemMessage?.trim();
	if (systemMessage) {
		params.agent.queueNextRunSystemPromptAddition(
			buildUserPromptHookSystemGuidance(systemMessage),
		);
	}

	const additionalContext = result.additionalContext?.trim();
	if (additionalContext) {
		params.agent.queueNextRunHistoryMessage(
			buildUserPromptHookContextMessage(additionalContext),
		);
	}
}

export async function runUserPromptWithRecovery(params: {
	agent: Agent;
	sessionManager: PromptRuntimeSessionManager;
	cwd: string;
	prompt: string;
	attachmentCount?: number;
	signal?: AbortSignal;
	execute: () => Promise<void>;
	callbacks?: PromptRecoveryCallbacks;
	maxOutputContinuations?: number;
}): Promise<void> {
	await applyUserPromptSubmitHooks(params);
	await runWithPromptRecovery({
		agent: params.agent,
		sessionManager: params.sessionManager,
		hookContext: buildCompactionHookContext(params.sessionManager, params.cwd),
		execute: params.execute,
		callbacks: params.callbacks,
		maxOutputContinuations: params.maxOutputContinuations,
	});
}
