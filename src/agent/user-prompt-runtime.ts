import { createSessionHookService } from "../hooks/session-integration.js";
import type { Agent } from "./agent.js";
import { buildCompactionHookContext } from "./compaction-hooks.js";
import {
	type PromptRecoveryCallbacks,
	type RunWithPromptRecoveryOptions,
	runWithPromptRecovery,
} from "./prompt-recovery.js";
import type { UserMessage } from "./types.js";

type PromptRuntimeSessionManager =
	RunWithPromptRecoveryOptions["sessionManager"] & {
		getSessionId?: () => string | undefined;
	};

function buildUserPromptHookContextMessage(text: string): UserMessage {
	return {
		role: "user",
		content: [
			{
				type: "text",
				text: `UserPromptSubmit hook context:\n${text}`,
			},
		],
		timestamp: Date.now(),
	};
}

function buildUserPromptHookSystemGuidance(text: string): string {
	return `UserPromptSubmit hook system guidance:\n${text}`;
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
		params.agent.queueNextRunPromptOnlyMessage(
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
