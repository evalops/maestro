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
import {
	getTaskBudgetTotal,
	setCurrentTaskBudget,
} from "./task-budget-access.js";
import {
	checkTokenBudget,
	createTokenBudgetTracker,
	formatTokenBudgetStatus,
	parseTokenBudget,
} from "./token-budget.js";
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

function findLatestTurnUserMessageIndex(
	messages: AppMessage[],
	turnStartedAt: number,
): number | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (
			message?.role === "user" &&
			typeof message.timestamp === "number" &&
			message.timestamp >= turnStartedAt
		) {
			return index;
		}
	}
	return undefined;
}

function resolveTurnAnchorIndex(
	messages: AppMessage[],
	messageStartIndex: number,
	turnStartedAt: number,
): number {
	return (
		findLatestTurnUserMessageIndex(messages, turnStartedAt) ??
		Math.min(messageStartIndex, messages.length)
	);
}

function getTurnOutputTokens(
	messages: AppMessage[],
	turnAnchorIndex: number,
): number {
	let total = 0;
	for (let index = turnAnchorIndex + 1; index < messages.length; index += 1) {
		const message = messages[index];
		if (message?.role === "assistant") {
			total += message.usage.output ?? 0;
		}
	}
	return total;
}

function setRecoverableOverflowErrorSuppression(
	agent: Agent,
	enabled: boolean,
): void {
	(
		agent as Agent & {
			setRecoverableOverflowErrorSuppression?: (enabled: boolean) => void;
		}
	).setRecoverableOverflowErrorSuppression?.(enabled);
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) {
		return;
	}

	if (signal.reason instanceof Error && signal.reason.name === "AbortError") {
		throw signal.reason;
	}

	const abortError = new Error(
		signal.reason instanceof Error
			? signal.reason.message
			: typeof signal.reason === "string" && signal.reason.length > 0
				? signal.reason
				: "Operation aborted",
	);
	abortError.name = "AbortError";
	throw abortError;
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

	const turnAnchorIndex = resolveTurnAnchorIndex(
		params.agent.state.messages,
		params.messageStartIndex,
		params.turnStartedAt,
	);
	const assistantMessage = findLatestAssistantMessage(
		params.agent.state.messages,
		turnAnchorIndex,
	);
	if (
		assistantMessage?.role === "assistant" &&
		assistantMessage.stopReason !== "stop"
	) {
		logger.debug("Skipping PostMessage hooks for non-final assistant message", {
			stopReason: assistantMessage.stopReason,
		});
		return;
	}

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

async function applyTokenBudgetContinuations(params: {
	agent: Agent;
	sessionManager: PromptRuntimeSessionManager;
	cwd: string;
	prompt: string;
	messageStartIndex: number;
	turnStartedAt: number;
	callbacks?: PromptRecoveryCallbacks;
	maxOutputContinuations?: number;
	signal?: AbortSignal;
}): Promise<void> {
	const budget = parseTokenBudget(params.prompt);
	if (budget === null || budget <= 0) {
		return;
	}

	const tracker = createTokenBudgetTracker();

	while (true) {
		throwIfAborted(params.signal);

		const turnAnchorIndex = resolveTurnAnchorIndex(
			params.agent.state.messages,
			params.messageStartIndex,
			params.turnStartedAt,
		);
		const lastAssistant = findLatestAssistantMessage(
			params.agent.state.messages,
			turnAnchorIndex,
		);
		if (
			lastAssistant?.role !== "assistant" ||
			lastAssistant.stopReason !== "stop"
		) {
			return;
		}

		const decision = checkTokenBudget(
			tracker,
			budget,
			getTurnOutputTokens(params.agent.state.messages, turnAnchorIndex),
		);
		if (decision.action === "stop") {
			return;
		}

		params.agent.emitStatus(
			formatTokenBudgetStatus(
				decision.turnOutputTokens,
				decision.budget,
				decision.pct,
			),
			{
				kind: "token_budget_continuation",
				budget: decision.budget,
				pct: decision.pct,
				turnOutputTokens: decision.turnOutputTokens,
				continuationCount: decision.continuationCount,
			},
		);

		logger.debug("Continuing turn toward explicit token budget", {
			budget: decision.budget,
			pct: decision.pct,
			turnOutputTokens: decision.turnOutputTokens,
			continuationCount: decision.continuationCount,
		});

		await runWithPromptRecovery({
			agent: params.agent,
			sessionManager: params.sessionManager,
			hookContext: buildCompactionHookContext(
				params.sessionManager,
				params.cwd,
			),
			execute: () =>
				params.agent.continue({
					continuationPrompt: decision.continuationPrompt,
				}),
			callbacks: params.callbacks,
			maxOutputContinuations: params.maxOutputContinuations,
		});

		throwIfAborted(params.signal);
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
	const taskBudgetTotal = getTaskBudgetTotal(params.agent);
	const abortAgent = () => {
		params.agent.abort();
	};

	if (params.signal) {
		if (params.signal.aborted) {
			abortAgent();
		} else {
			params.signal.addEventListener("abort", abortAgent, { once: true });
		}
	}

	setRecoverableOverflowErrorSuppression(params.agent, true);
	setCurrentTaskBudget(
		params.agent,
		typeof taskBudgetTotal === "number"
			? { total: taskBudgetTotal }
			: undefined,
	);
	try {
		throwIfAborted(params.signal);
		await applyUserPromptSubmitHooks(params);
		throwIfAborted(params.signal);
		await applyPreMessageHooks(params);
		throwIfAborted(params.signal);
		await runWithPromptRecovery({
			agent: params.agent,
			sessionManager: params.sessionManager,
			hookContext: buildCompactionHookContext(
				params.sessionManager,
				params.cwd,
			),
			execute: params.execute,
			callbacks: params.callbacks,
			maxOutputContinuations: params.maxOutputContinuations,
		});
		throwIfAborted(params.signal);
		await applyTokenBudgetContinuations({
			agent: params.agent,
			sessionManager: params.sessionManager,
			cwd: params.cwd,
			prompt: params.prompt,
			messageStartIndex,
			turnStartedAt,
			callbacks: params.callbacks,
			maxOutputContinuations: params.maxOutputContinuations,
			signal: params.signal,
		});
		throwIfAborted(params.signal);
		await applyPostMessageHooks({
			agent: params.agent,
			sessionManager: params.sessionManager,
			cwd: params.cwd,
			messageStartIndex,
			turnStartedAt,
			signal: params.signal,
		});
	} finally {
		params.signal?.removeEventListener("abort", abortAgent);
		setCurrentTaskBudget(params.agent, undefined);
		setRecoverableOverflowErrorSuppression(params.agent, false);
	}
}
