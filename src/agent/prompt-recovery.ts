import { isContextOverflow as isOverflowError } from "../utils/context-overflow.js";
import { createLogger } from "../utils/logger.js";
import type { Agent } from "./agent.js";
import * as compactionHooks from "./compaction-hooks.js";
import type {
	CompactionHookContext,
	CompactionHookService,
	OverflowHookService,
	StopFailureHookService,
} from "./compaction-hooks.js";
import {
	type CompactionSessionManager,
	type PerformCompactionResult,
	performCompaction,
} from "./compaction.js";
import {
	isContextOverflow as isAssistantContextOverflow,
	parseOverflowDetails,
} from "./context-overflow.js";
import { isAssistantMessage } from "./type-guards.js";
import type { AppMessage, AssistantMessage } from "./types.js";

const logger = createLogger("agent:prompt-recovery");

const DEFAULT_MAX_OUTPUT_CONTINUATIONS = 5;
const MAX_OUTPUT_ESCALATION_TOKENS = 64_000;
const MAX_OUTPUT_DIMINISHING_THRESHOLD_TOKENS = 500;
const MAX_OUTPUT_DIMINISHING_MIN_ATTEMPTS = 3;
const MAX_OUTPUT_CONTINUATION_PROMPT =
	"Output token limit hit. Resume directly with the unfinished answer. No apology, no recap, and no restating the task. Pick up mid-thought if needed, and keep the remaining work broken into smaller pieces.";
const POST_COMPACTION_CONTINUATION_PROMPT =
	"Continue directly with the user's unresolved request after compaction. No apology or recap unless it is required to finish correctly.";

export interface PromptRecoveryCallbacks {
	onCompacting?: () => void;
	onCompacted?: (result: PerformCompactionResult) => void;
	onCompactionFailed?: (message: string) => void;
	onMaxOutputContinue?: (attempt: number, maxContinuations: number) => void;
	onMaxOutputExhausted?: (maxContinuations: number) => void;
	onMaxOutputStoppedEarly?: (attempt: number, maxContinuations: number) => void;
}

export interface RunWithPromptRecoveryOptions {
	agent: Agent;
	sessionManager: CompactionSessionManager;
	execute: () => Promise<void>;
	hookContext?: CompactionHookContext;
	hookService?: CompactionHookService;
	overflowHookService?: OverflowHookService;
	stopFailureHookService?: StopFailureHookService;
	callbacks?: PromptRecoveryCallbacks;
	maxOutputContinuations?: number;
}

export interface MaxOutputRecoveryResult {
	recovered: boolean;
	attempts: number;
	exhausted: boolean;
	stoppedEarly: boolean;
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

function getAssistantText(message?: AssistantMessage): string | undefined {
	if (!message) {
		return undefined;
	}

	const text = message.content
		.filter(
			(
				block,
			): block is Extract<
				AssistantMessage["content"][number],
				{ type: "text" }
			> => block.type === "text",
		)
		.map((block) => block.text.trim())
		.filter(Boolean)
		.join("\n")
		.trim();

	return text || undefined;
}

function getAssistantOutputTokens(
	message?: AssistantMessage,
): number | undefined {
	const output = message?.usage.output;
	return typeof output === "number" && output > 0 ? output : undefined;
}

function getErrorMessage(error: unknown): string | undefined {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	return undefined;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function getTerminalStopFailure(
	newMessages: AppMessage[],
	executionError: unknown,
): {
	error: string;
	errorDetails?: string;
	lastAssistantMessage?: string;
} | null {
	const lastAssistant = getLastAssistantMessage(newMessages);
	if (lastAssistant?.stopReason === "error") {
		return {
			error: "api_error",
			errorDetails:
				lastAssistant.errorMessage ?? getErrorMessage(executionError),
			lastAssistantMessage: getAssistantText(lastAssistant),
		};
	}

	if (executionError === undefined || isAbortError(executionError)) {
		return null;
	}

	return {
		error: "runtime_error",
		errorDetails: getErrorMessage(executionError),
		lastAssistantMessage: getAssistantText(lastAssistant),
	};
}

function shouldEscalateMaxOutputCap(agent: Agent): boolean {
	return (
		agent.state.model.provider === "anthropic" &&
		agent.state.model.maxTokens < MAX_OUTPUT_ESCALATION_TOKENS
	);
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

function getOverflowErrorMessage(
	newMessages: AppMessage[],
	error?: unknown,
): string | undefined {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	return getLastAssistantMessage(newMessages)?.errorMessage;
}

function buildOverflowHookGuidance(result: {
	systemMessage?: string;
	additionalContext?: string;
}): string | undefined {
	const sections = [
		result.systemMessage?.trim()
			? `Overflow hook system guidance:\n${result.systemMessage.trim()}`
			: null,
		result.additionalContext?.trim()
			? `Overflow hook context:\n${result.additionalContext.trim()}`
			: null,
	].filter((section): section is string => Boolean(section));

	return sections.length > 0 ? sections.join("\n\n") : undefined;
}

async function runStopFailureHooks(
	options: RunWithPromptRecoveryOptions,
	params: {
		error: string;
		errorDetails?: string;
		lastAssistantMessage?: string;
	},
): Promise<void> {
	const { hookContext } = options;
	const stopFailureHookService =
		options.stopFailureHookService ??
		(hookContext
			? compactionHooks.createStopFailureHookService(hookContext)
			: undefined);
	if (!stopFailureHookService) {
		return;
	}
	if (
		stopFailureHookService.hasHooks &&
		!stopFailureHookService.hasHooks("StopFailure")
	) {
		return;
	}

	try {
		const result = await stopFailureHookService.runStopFailureHooks(
			params.error,
			params.errorDetails,
			params.lastAssistantMessage,
			hookContext?.signal,
		);

		if (
			result.blocked ||
			result.preventContinuation ||
			result.systemMessage ||
			result.additionalContext
		) {
			logger.warn(
				"StopFailure hooks returned unsupported control or context output; ignoring",
				{
					error: params.error,
					blocked: result.blocked,
					preventContinuation: result.preventContinuation,
				},
			);
		}
	} catch (error) {
		logger.warn("StopFailure hooks failed", {
			error: error instanceof Error ? error.message : String(error),
			stopFailureCode: params.error,
		});
	}
}

async function runOverflowHooks(
	agent: Agent,
	newMessages: AppMessage[],
	error: unknown,
	options: RunWithPromptRecoveryOptions,
): Promise<string | undefined> {
	const { hookContext } = options;
	const overflowHookService =
		options.overflowHookService ??
		(hookContext
			? compactionHooks.createOverflowHookService(hookContext)
			: undefined);
	if (!overflowHookService) {
		return undefined;
	}
	if (
		overflowHookService.hasHooks &&
		!overflowHookService.hasHooks("Overflow")
	) {
		return undefined;
	}

	const overflowMessage = getOverflowErrorMessage(newMessages, error);
	const parsedDetails = overflowMessage
		? parseOverflowDetails(overflowMessage)
		: null;
	const lastAssistant = getLastAssistantMessage(newMessages);
	const fallbackTokenCount = lastAssistant?.usage
		? lastAssistant.usage.input +
			lastAssistant.usage.cacheRead +
			lastAssistant.usage.cacheWrite
		: agent.state.model.contextWindow;

	const result = await overflowHookService.runOverflowHooks(
		parsedDetails?.requestedTokens ?? fallbackTokenCount,
		parsedDetails?.maxTokens ?? agent.state.model.contextWindow,
		agent.state.model.id,
		hookContext?.signal,
	);

	if (result.blocked) {
		throw new Error(result.blockReason ?? "Overflow hook blocked recovery");
	}
	if (result.preventContinuation) {
		throw new Error(
			result.stopReason ?? "Overflow hook prevented automatic recovery",
		);
	}

	return buildOverflowHookGuidance(result);
}

export async function recoverFromMaxOutput(
	agent: Agent,
	options?: {
		callbacks?: Pick<
			PromptRecoveryCallbacks,
			"onMaxOutputContinue" | "onMaxOutputExhausted" | "onMaxOutputStoppedEarly"
		>;
		maxContinuations?: number;
	},
): Promise<MaxOutputRecoveryResult> {
	const maxContinuations =
		options?.maxContinuations ?? DEFAULT_MAX_OUTPUT_CONTINUATIONS;
	let attempt = 0;
	let previousContinuationOutputTokens: number | undefined;

	if (shouldEscalateMaxOutputCap(agent)) {
		const lastAssistant = getLastAssistantMessage(agent.state.messages);
		if (lastAssistant?.stopReason === "length") {
			await agent.continue({
				maxTokensOverride: MAX_OUTPUT_ESCALATION_TOKENS,
			});
		}
	}

	while (attempt < maxContinuations) {
		const lastAssistant = getLastAssistantMessage(agent.state.messages);
		if (!lastAssistant || lastAssistant.stopReason !== "length") {
			return {
				recovered: attempt > 0,
				attempts: attempt,
				exhausted: false,
				stoppedEarly: false,
			};
		}

		const currentOutputTokens = getAssistantOutputTokens(lastAssistant);
		const shouldStopForDiminishingReturns =
			attempt >= MAX_OUTPUT_DIMINISHING_MIN_ATTEMPTS &&
			typeof previousContinuationOutputTokens === "number" &&
			typeof currentOutputTokens === "number" &&
			previousContinuationOutputTokens <
				MAX_OUTPUT_DIMINISHING_THRESHOLD_TOKENS &&
			currentOutputTokens < MAX_OUTPUT_DIMINISHING_THRESHOLD_TOKENS;
		if (shouldStopForDiminishingReturns) {
			options?.callbacks?.onMaxOutputStoppedEarly?.(attempt, maxContinuations);
			logger.info("Stopped automatic continuation after diminishing returns", {
				attempt,
				maxContinuations,
				previousOutputTokens: previousContinuationOutputTokens,
				currentOutputTokens,
			});
			return {
				recovered: attempt > 0,
				attempts: attempt,
				exhausted: false,
				stoppedEarly: true,
			};
		}

		attempt += 1;
		options?.callbacks?.onMaxOutputContinue?.(attempt, maxContinuations);
		previousContinuationOutputTokens = currentOutputTokens;
		await agent.continue({
			continuationPrompt: MAX_OUTPUT_CONTINUATION_PROMPT,
		});
	}

	const lastAssistant = getLastAssistantMessage(agent.state.messages);
	if (lastAssistant?.stopReason === "length") {
		options?.callbacks?.onMaxOutputExhausted?.(maxContinuations);
		return {
			recovered: attempt > 0,
			attempts: attempt,
			exhausted: true,
			stoppedEarly: false,
		};
	}
	return {
		recovered: attempt > 0,
		attempts: attempt,
		exhausted: false,
		stoppedEarly: false,
	};
}

async function recoverFromPromptOverflow(
	agent: Agent,
	sessionManager: CompactionSessionManager,
	hookContext: CompactionHookContext | undefined,
	hookService: CompactionHookService | undefined,
	customInstructions: string | undefined,
	persistCustomInstructions: boolean,
	callbacks?: PromptRecoveryCallbacks,
): Promise<boolean> {
	callbacks?.onCompacting?.();

	let result: PerformCompactionResult;
	try {
		result = await performCompaction({
			agent,
			sessionManager,
			auto: true,
			trigger: "token_limit",
			hookContext,
			hookService,
			customInstructions,
			persistCustomInstructions,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		callbacks?.onCompactionFailed?.(message);
		throw error;
	}

	if (!result.success) {
		logger.warn("Prompt overflow compaction failed", {
			error: result.error,
		});
		callbacks?.onCompactionFailed?.(result.error ?? "unknown error");
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
	let stopFailureReported = false;

	const reportStopFailure = async (params: {
		error: string;
		errorDetails?: string;
		lastAssistantMessage?: string;
	}) => {
		if (stopFailureReported) {
			return;
		}
		stopFailureReported = true;
		await runStopFailureHooks(options, params);
	};

	try {
		await execute();
	} catch (error) {
		executionError = error;
	}

	newMessages = agent.state.messages.slice(initialMessageCount);

	if (hasPromptOverflow(agent, newMessages, executionError)) {
		try {
			const overflowHookGuidance = await runOverflowHooks(
				agent,
				newMessages,
				executionError,
				options,
			);
			const recovered = await recoverFromPromptOverflow(
				agent,
				sessionManager,
				options.hookContext,
				options.hookService,
				overflowHookGuidance,
				overflowHookGuidance === undefined,
				callbacks,
			);
			if (recovered) {
				const recoveredMessages = agent.state.messages;
				const recoveredOverflowError = getPromptOverflowAssistantError(
					agent,
					recoveredMessages,
				);
				if (recoveredOverflowError) {
					await reportStopFailure({
						error: "prompt_overflow",
						errorDetails: recoveredOverflowError.message,
						lastAssistantMessage: getAssistantText(
							getLastAssistantMessage(agent.state.messages),
						),
					});
					throw recoveredOverflowError;
				}

				const recoveredTerminalStopFailure = getTerminalStopFailure(
					recoveredMessages,
					undefined,
				);
				if (recoveredTerminalStopFailure) {
					await reportStopFailure(recoveredTerminalStopFailure);
					return;
				}

				const maxOutputRecovery = await recoverFromMaxOutput(agent, {
					callbacks,
					maxContinuations: options.maxOutputContinuations,
				});
				const postContinuationOverflowError = getPromptOverflowAssistantError(
					agent,
					agent.state.messages,
				);
				if (postContinuationOverflowError) {
					await reportStopFailure({
						error: "prompt_overflow",
						errorDetails: postContinuationOverflowError.message,
						lastAssistantMessage: getAssistantText(
							getLastAssistantMessage(agent.state.messages),
						),
					});
					throw postContinuationOverflowError;
				}
				const postContinuationStopFailure = getTerminalStopFailure(
					agent.state.messages,
					undefined,
				);
				if (postContinuationStopFailure) {
					await reportStopFailure(postContinuationStopFailure);
					return;
				}
				const lastAssistant = getLastAssistantMessage(agent.state.messages);
				if (lastAssistant?.stopReason === "length") {
					await reportStopFailure({
						error: "max_output_tokens",
						errorDetails: maxOutputRecovery.stoppedEarly
							? `Automatic continuation stopped early after ${maxOutputRecovery.attempts} automatic continuations because recent retries made minimal progress.`
							: "Automatic continuation recovery exhausted before the model completed the response.",
						lastAssistantMessage: getAssistantText(lastAssistant),
					});
				}
				return;
			}

			const assistantOverflowError = getPromptOverflowAssistantError(
				agent,
				newMessages,
			);
			await reportStopFailure({
				error: "prompt_overflow",
				errorDetails:
					assistantOverflowError?.message ??
					getOverflowErrorMessage(newMessages, executionError) ??
					"Prompt overflow could not be recovered.",
				lastAssistantMessage: getAssistantText(
					getLastAssistantMessage(agent.state.messages),
				),
			});
			if (assistantOverflowError) {
				throw assistantOverflowError;
			}
		} catch (error) {
			await reportStopFailure({
				error: "prompt_overflow",
				errorDetails: error instanceof Error ? error.message : String(error),
				lastAssistantMessage: getAssistantText(
					getLastAssistantMessage(agent.state.messages),
				),
			});
			logger.warn("Prompt overflow recovery continuation failed", {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	}

	if (executionError !== undefined) {
		const terminalStopFailure = getTerminalStopFailure(
			newMessages,
			executionError,
		);
		if (terminalStopFailure) {
			await reportStopFailure(terminalStopFailure);
		}
		throw executionError;
	}

	const terminalStopFailure = getTerminalStopFailure(
		newMessages,
		executionError,
	);
	if (terminalStopFailure) {
		await reportStopFailure(terminalStopFailure);
		return;
	}

	const maxOutputRecovery = await recoverFromMaxOutput(agent, {
		callbacks,
		maxContinuations: options.maxOutputContinuations,
	});
	const lastAssistant = getLastAssistantMessage(agent.state.messages);
	if (lastAssistant?.stopReason === "length") {
		await reportStopFailure({
			error: "max_output_tokens",
			errorDetails: maxOutputRecovery.stoppedEarly
				? `Automatic continuation stopped early after ${maxOutputRecovery.attempts} automatic continuations because recent retries made minimal progress.`
				: "Automatic continuation recovery exhausted before the model completed the response.",
			lastAssistantMessage: getAssistantText(lastAssistant),
		});
	}
}
