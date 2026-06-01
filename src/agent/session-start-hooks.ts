import { createSessionHookService } from "../hooks/session-integration.js";
import { createLogger } from "../utils/logger.js";
import type { Agent } from "./agent.js";
import { createHookMessage } from "./custom-messages.js";
import { SESSION_START_INITIAL_USER_METADATA_KIND } from "./session-start-metadata.js";
import type { AppMessage, HookMessage, UserMessage } from "./types.js";

type SessionStartSessionManager = {
	getSessionId?: () => string | undefined;
	saveMessage?: (message: AppMessage) => void;
};
type SessionStartHookDelivery = "queue" | "persistHistory";

interface SessionStartHookOutputs {
	systemMessage?: string;
	additionalContext?: string;
	initialUserMessage?: string;
}

const logger = createLogger("session-start-hooks");

function buildSessionStartHookContextMessage(text: string): HookMessage {
	return createHookMessage(
		"SessionStart",
		text,
		true,
		undefined,
		new Date().toISOString(),
	);
}

function buildSessionStartInitialUserMessage(
	text: string,
	source?: string,
): UserMessage {
	return {
		role: "user",
		content: text,
		metadata: {
			kind: SESSION_START_INITIAL_USER_METADATA_KIND,
			source,
		},
		timestamp: Date.now(),
	};
}

function buildSessionStartHookSystemGuidance(text: string): string {
	return `SessionStart hook system guidance:\n${text}`;
}

function buildPersistedSessionStartHookSystemMessage(
	text: string,
): HookMessage {
	return createHookMessage(
		"SessionStart",
		buildSessionStartHookSystemGuidance(text),
		true,
		undefined,
		new Date().toISOString(),
	);
}

async function runSessionStartHooksInternal(params: {
	sessionManager: SessionStartSessionManager;
	cwd: string;
	source: string;
	signal?: AbortSignal;
}): Promise<SessionStartHookOutputs | null> {
	const service = createSessionHookService({
		cwd: params.cwd,
		sessionId: params.sessionManager.getSessionId?.(),
	});
	if (!service.hasHooks("SessionStart")) {
		return null;
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

	return {
		systemMessage: result.systemMessage?.trim(),
		additionalContext: result.additionalContext?.trim(),
		initialUserMessage: result.initialUserMessage?.trim(),
	};
}

function buildPersistedSessionStartHookMessages(
	outputs: SessionStartHookOutputs | null,
	source: string,
): AppMessage[] {
	if (!outputs) {
		return [];
	}

	const persistedMessages: AppMessage[] = [];
	if (outputs.systemMessage) {
		persistedMessages.push(
			buildPersistedSessionStartHookSystemMessage(outputs.systemMessage),
		);
	}
	if (outputs.additionalContext) {
		persistedMessages.push(
			buildSessionStartHookContextMessage(outputs.additionalContext),
		);
	}
	if (outputs.initialUserMessage) {
		persistedMessages.push(
			buildSessionStartInitialUserMessage(outputs.initialUserMessage, source),
		);
	}
	return persistedMessages;
}

export async function collectPersistedSessionStartHookMessages(params: {
	sessionManager: SessionStartSessionManager;
	cwd: string;
	source: string;
	signal?: AbortSignal;
}): Promise<AppMessage[]> {
	return buildPersistedSessionStartHookMessages(
		await runSessionStartHooksInternal(params),
		params.source,
	);
}

export async function applySessionStartHooks(params: {
	agent: Agent;
	sessionManager: SessionStartSessionManager;
	cwd: string;
	source: string;
	signal?: AbortSignal;
	delivery?: SessionStartHookDelivery;
}): Promise<void> {
	if (params.delivery === "persistHistory") {
		const persistedMessages = await collectPersistedSessionStartHookMessages({
			sessionManager: params.sessionManager,
			cwd: params.cwd,
			source: params.source,
			signal: params.signal,
		});
		for (const message of persistedMessages) {
			params.agent.appendMessage(message);
			params.sessionManager.saveMessage?.(message);
		}
		return;
	}

	const outputs = await runSessionStartHooksInternal({
		sessionManager: params.sessionManager,
		cwd: params.cwd,
		source: params.source,
		signal: params.signal,
	});
	if (!outputs) {
		return;
	}

	if (outputs.systemMessage) {
		params.agent.queueNextRunSystemPromptAddition(
			buildSessionStartHookSystemGuidance(outputs.systemMessage),
		);
	}
	if (outputs.additionalContext) {
		params.agent.queueNextRunHistoryMessage(
			buildSessionStartHookContextMessage(outputs.additionalContext),
		);
	}
	if (outputs.initialUserMessage) {
		params.agent.queueNextRunHistoryMessage(
			buildSessionStartInitialUserMessage(
				outputs.initialUserMessage,
				params.source,
			),
		);
	}
}
