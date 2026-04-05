import { createLogger } from "../utils/logger.js";
import type { Agent } from "./agent.js";
import type { AppMessage } from "./types.js";

const logger = createLogger("max-output-recovery");

export interface MaxOutputRecoveryOptions {
	enabled?: boolean;
	maxContinuations?: number;
	onContinue?: (attempt: number, maxContinuations: number) => void;
	onExhausted?: (maxContinuations: number) => void;
	onStoppedEarly?: (attempt: number, maxContinuations: number) => void;
}

export interface MaxOutputRecoveryResult {
	recovered: boolean;
	attempts: number;
	exhausted: boolean;
	stoppedEarly: boolean;
}

const DEFAULT_MAX_CONTINUATIONS = 5;
const DIMINISHING_THRESHOLD_TOKENS = 500;
const DIMINISHING_MIN_ATTEMPTS = 3;

function lastAssistantHitMaxOutput(messages: AppMessage[]): boolean {
	const lastMessage = messages[messages.length - 1];
	return (
		lastMessage?.role === "assistant" && lastMessage.stopReason === "length"
	);
}

function lastAssistantOutputTokens(messages: AppMessage[]): number | undefined {
	const lastMessage = messages[messages.length - 1];
	if (lastMessage?.role !== "assistant") {
		return undefined;
	}

	const output = lastMessage.usage.output;
	return typeof output === "number" && output > 0 ? output : undefined;
}

export async function recoverFromMaxOutput(
	agent: Pick<Agent, "state" | "continue">,
	options: MaxOutputRecoveryOptions = {},
): Promise<MaxOutputRecoveryResult> {
	const enabled = options.enabled ?? true;
	const maxContinuations = Math.max(
		1,
		options.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS,
	);

	if (!enabled) {
		return {
			recovered: false,
			attempts: 0,
			exhausted: false,
			stoppedEarly: false,
		};
	}

	let attempts = 0;
	let previousContinuationOutputTokens: number | undefined;

	while (
		attempts < maxContinuations &&
		lastAssistantHitMaxOutput(agent.state.messages)
	) {
		const currentOutputTokens = lastAssistantOutputTokens(agent.state.messages);
		const shouldStopForDiminishingReturns =
			attempts >= DIMINISHING_MIN_ATTEMPTS &&
			typeof previousContinuationOutputTokens === "number" &&
			typeof currentOutputTokens === "number" &&
			previousContinuationOutputTokens < DIMINISHING_THRESHOLD_TOKENS &&
			currentOutputTokens < DIMINISHING_THRESHOLD_TOKENS;
		if (shouldStopForDiminishingReturns) {
			options.onStoppedEarly?.(attempts, maxContinuations);
			logger.info("Stopped automatic continuation after diminishing returns", {
				attempts,
				maxContinuations,
				previousOutputTokens: previousContinuationOutputTokens,
				currentOutputTokens,
			});
			return {
				recovered: attempts > 0,
				attempts,
				exhausted: false,
				stoppedEarly: true,
			};
		}

		attempts += 1;
		options.onContinue?.(attempts, maxContinuations);
		logger.info("Continuing after max output stop", {
			attempt: attempts,
			maxContinuations,
		});
		previousContinuationOutputTokens = currentOutputTokens;
		await agent.continue();
	}

	const exhausted =
		attempts >= maxContinuations &&
		lastAssistantHitMaxOutput(agent.state.messages);

	if (exhausted) {
		options.onExhausted?.(maxContinuations);
		logger.warn("Stopped automatic continuation after max output limit", {
			maxContinuations,
		});
	}

	return {
		recovered: attempts > 0,
		attempts,
		exhausted,
		stoppedEarly: false,
	};
}
