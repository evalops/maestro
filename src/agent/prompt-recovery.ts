import { isContextOverflow as isOverflowError } from "../utils/context-overflow.js";
import { createLogger } from "../utils/logger.js";
import type { Agent } from "./agent.js";
import {
	type CompactionSessionManager,
	type PerformCompactionResult,
	performCompaction,
} from "./compaction.js";
import { isContextOverflow as isAssistantContextOverflow } from "./context-overflow.js";
import { isAssistantMessage } from "./type-guards.js";
import type { AppMessage, AssistantMessage } from "./types.js";

const logger = createLogger("agent:prompt-recovery");

const DEFAULT_MAX_OUTPUT_CONTINUATIONS = 3;
const MAX_OUTPUT_CONTINUATION_PROMPT =
	"Output token limit hit. Resume directly with the unfinished answer. No apology, no recap, and no restating the task. Pick up mid-thought if needed, and keep the remaining work broken into smaller pieces.";
const POST_COMPACTION_CONTINUATION_PROMPT =
	"Continue directly with the user's unresolved request after compaction. No apology or recap unless it is required to finish correctly.";

export interface PromptRecoveryCallbacks {
	onCompacting?: () => void;
	onCompacted?: (result: PerformCompactionResult) => void;
	onMaxOutputContinue?: (attempt: number, maxContinuations: number) => void;
	onMaxOutputExhausted?: (maxContinuations: number) => void;
}

export interface RunWithPromptRecoveryOptions {
	agent: Agent;
	sessionManager: CompactionSessionManager;
	execute: () => Promise<void>;
	callbacks?: PromptRecoveryCallbacks;
	maxOutputContinuations?: number;
}

export function buildCompactionEvent(
	result: PerformCompactionResult,
	options?: {
		auto?: boolean;
		customInstructions?: string;
		timestamp?: string;
	},
) {
	return {
		type: "compaction" as const,
		summary:
			result.summary ?? `Compacted ${result.compactedCount ?? 0} messages`,
		firstKeptEntryIndex: result.firstKeptEntryIndex ?? 0,
		tokensBefore: result.tokensBefore ?? 0,
		auto: Boolean(options?.auto),
		customInstructions: options?.customInstructions,
		timestamp: options?.timestamp ?? new Date().toISOString(),
	};
}

function getLastAssistantMessage(
	messages: AppMessage[],
): AssistantMessage | undefined {
	const lastMessage = messages[messages.length - 1];
	return lastMessage && isAssistantMessage(lastMessage)
		? lastMessage
		: undefined;
}

function hasPromptOverflow(
	agent: Agent,
	newMessages: AppMessage[],
	error?: unknown,
): boolean {
	if (error instanceof Error || typeof error === "string") {
		return isOverflowError(error, agent.state.model);
	}

	const lastAssistant = getLastAssistantMessage(newMessages);
	return Boolean(
		lastAssistant &&
			lastAssistant.stopReason === "error" &&
			isAssistantContextOverflow(
				lastAssistant,
				agent.state.model.contextWindow,
			),
	);
}

function getPromptOverflowAssistantError(
	agent: Agent,
	newMessages: AppMessage[],
): Error | undefined {
	const lastAssistant = getLastAssistantMessage(newMessages);
	if (
		lastAssistant &&
		lastAssistant.stopReason === "error" &&
		isAssistantContextOverflow(lastAssistant, agent.state.model.contextWindow)
	) {
		return new Error(
			lastAssistant.errorMessage || "Prompt overflow could not be recovered.",
		);
	}

	return undefined;
}

export async function recoverFromMaxOutput(
	agent: Agent,
	options?: {
		callbacks?: Pick<
			PromptRecoveryCallbacks,
			"onMaxOutputContinue" | "onMaxOutputExhausted"
		>;
		maxContinuations?: number;
	},
): Promise<boolean> {
	const maxContinuations =
		options?.maxContinuations ?? DEFAULT_MAX_OUTPUT_CONTINUATIONS;
	let attempt = 0;

	while (attempt < maxContinuations) {
		const lastAssistant = getLastAssistantMessage(agent.state.messages);
		if (!lastAssistant || lastAssistant.stopReason !== "length") {
			return attempt > 0;
		}

		attempt += 1;
		options?.callbacks?.onMaxOutputContinue?.(attempt, maxContinuations);
		await agent.continue({
			continuationPrompt: MAX_OUTPUT_CONTINUATION_PROMPT,
		});
	}

	const lastAssistant = getLastAssistantMessage(agent.state.messages);
	if (lastAssistant?.stopReason === "length") {
		options?.callbacks?.onMaxOutputExhausted?.(maxContinuations);
	}
	return attempt > 0;
}

async function recoverFromPromptOverflow(
	agent: Agent,
	sessionManager: CompactionSessionManager,
	callbacks?: PromptRecoveryCallbacks,
): Promise<boolean> {
	callbacks?.onCompacting?.();

	const result = await performCompaction({
		agent,
		sessionManager,
		auto: true,
	});

	if (!result.success) {
		logger.warn("Prompt overflow compaction failed", {
			error: result.error,
		});
		return false;
	}

	callbacks?.onCompacted?.(result);
	await agent.continue({
		continuationPrompt: POST_COMPACTION_CONTINUATION_PROMPT,
	});
	return true;
}

export async function runWithPromptRecovery(
	options: RunWithPromptRecoveryOptions,
): Promise<void> {
	const { agent, sessionManager, execute, callbacks } = options;
	const initialMessageCount = agent.state.messages.length;
	let executionError: unknown;
	let newMessages: AppMessage[] = [];

	try {
		await execute();
	} catch (error) {
		executionError = error;
	}

	newMessages = agent.state.messages.slice(initialMessageCount);

	if (hasPromptOverflow(agent, newMessages, executionError)) {
		try {
			const recovered = await recoverFromPromptOverflow(
				agent,
				sessionManager,
				callbacks,
			);
			if (recovered) {
				await recoverFromMaxOutput(agent, {
					callbacks,
					maxContinuations: options.maxOutputContinuations,
				});
				return;
			}

			const assistantOverflowError = getPromptOverflowAssistantError(
				agent,
				newMessages,
			);
			if (assistantOverflowError) {
				throw assistantOverflowError;
			}
		} catch (error) {
			logger.warn("Prompt overflow recovery continuation failed", {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	if (executionError !== undefined) {
		throw executionError;
	}

	await recoverFromMaxOutput(agent, {
		callbacks,
		maxContinuations: options.maxOutputContinuations,
	});
}
