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
import type { AppMessage, HookMessage, UserMessage } from "./types.js";

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

function buildPreMessageHookContextMessage(text: string): UserMessage {
	return {
		role: "user",
		content: [
			{
				type: "text",
				text: `PreMessage hook context:\n${text}`,
			},
		],
		timestamp: Date.now(),
	};
}

function buildPreMessageHookSystemGuidance(text: string): string {
	return `PreMessage hook system guidance:\n${text}`;
}

function extractAssistantText(message: AppMessage | undefined): string {
	if (!message || message.role !== "assistant") {
		return "";
	}
	return message.content
		.filter(
			(block): block is { type: "text"; text: string } => block.type === "text",
		)
		.map((block) => block.text)
		.join("");
}

function findLatestAssistantMessage(
	messages: AppMessage[],
	startIndex: number,
): AppMessage | undefined {
	for (let index = messages.length - 1; index >= startIndex; index -= 1) {
		const message = messages[index];
		if (message?.role === "assistant") {
			return message;
		}
	}
	return undefined;
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

export async function applyPreMessageHooks(params: {
	agent: Agent;
	sessionManager: PromptRuntimeSessionManager;
	cwd: string;
	prompt: string;
	attachmentNames?: string[];
	signal?: AbortSignal;
}): Promise<void> {
	const service = createSessionHookService({
		cwd: params.cwd,
		sessionId: params.sessionManager.getSessionId?.(),
	});
	if (!service.hasHooks("PreMessage")) {
		return;
	}

	const result = await service.runPreMessageHooks(
		params.prompt,
		params.attachmentNames ?? [],
		params.agent.state.model.id,
		params.signal,
	);
	if (result.blocked) {
		throw new Error(
			result.blockReason ?? "PreMessage hook blocked this prompt.",
		);
	}
	if (result.preventContinuation) {
		throw new Error(
			result.stopReason ?? "PreMessage hook stopped this prompt.",
		);
	}

	const systemMessage = result.systemMessage?.trim();
	if (systemMessage) {
		params.agent.queueNextRunSystemPromptAddition(
			buildPreMessageHookSystemGuidance(systemMessage),
		);
	}

	const additionalContext = result.additionalContext?.trim();
	if (additionalContext) {
		params.agent.queueNextRunPromptOnlyMessage(
			buildPreMessageHookContextMessage(additionalContext),
		);
	}
}

async function applyPostMessageHooks(params: {
	agent: Agent;
	sessionManager: PromptRuntimeSessionManager;
	cwd: string;
	messageStartIndex: number;
	turnStartedAt: number;
	signal?: AbortSignal;
}): Promise<void> {
	const service = createSessionHookService({
		cwd: params.cwd,
		sessionId: params.sessionManager.getSessionId?.(),
	});
	if (!service.hasHooks("PostMessage")) {
		return;
	}

	const assistantMessage = findLatestAssistantMessage(
		params.agent.state.messages,
		params.messageStartIndex,
	);
	const response = extractAssistantText(assistantMessage).trim();
	if (!response) {
		return;
	}

	const usage =
		assistantMessage?.role === "assistant" ? assistantMessage.usage : undefined;
	const result = await service.runPostMessageHooks(
		response,
		usage?.input ?? 0,
		usage?.output ?? 0,
		Math.max(0, Date.now() - params.turnStartedAt),
		assistantMessage?.role === "assistant"
			? assistantMessage.stopReason
			: undefined,
		params.signal,
	);
	if (
		result.blocked ||
		result.preventContinuation ||
		result.additionalContext ||
		result.systemMessage ||
		result.initialUserMessage
	) {
		logger.warn(
			"PostMessage hook returned unsupported control or context output; ignoring",
			{
				blocked: result.blocked,
				preventContinuation: result.preventContinuation,
				hasAdditionalContext: Boolean(result.additionalContext),
				hasSystemMessage: Boolean(result.systemMessage),
				hasInitialUserMessage: Boolean(result.initialUserMessage),
				reason: result.blockReason ?? result.stopReason,
			},
		);
	}
}

export async function runUserPromptWithRecovery(params: {
	agent: Agent;
	sessionManager: PromptRuntimeSessionManager;
	cwd: string;
	prompt: string;
	attachmentCount?: number;
	attachmentNames?: string[];
	signal?: AbortSignal;
	execute: () => Promise<void>;
	callbacks?: PromptRecoveryCallbacks;
	maxOutputContinuations?: number;
}): Promise<void> {
	const messageStartIndex = params.agent.state.messages.length;
	const turnStartedAt = Date.now();
	await applyUserPromptSubmitHooks(params);
	await applyPreMessageHooks(params);
	await runWithPromptRecovery({
		agent: params.agent,
		sessionManager: params.sessionManager,
		hookContext: buildCompactionHookContext(params.sessionManager, params.cwd),
		execute: params.execute,
		callbacks: params.callbacks,
		maxOutputContinuations: params.maxOutputContinuations,
	});
	await applyPostMessageHooks({
		agent: params.agent,
		sessionManager: params.sessionManager,
		cwd: params.cwd,
		messageStartIndex,
		turnStartedAt,
		signal: params.signal,
	});
}
