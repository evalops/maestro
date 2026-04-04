import { createLogger } from "../utils/logger.js";
import type { Agent } from "./agent.js";
import type { AppMessage } from "./types.js";

const logger = createLogger("max-output-recovery");

export interface MaxOutputRecoveryOptions {
	enabled?: boolean;
	maxContinuations?: number;
	onContinue?: (attempt: number, maxContinuations: number) => void;
	onExhausted?: (maxContinuations: number) => void;
}

export interface MaxOutputRecoveryResult {
	recovered: boolean;
	attempts: number;
	exhausted: boolean;
}

const DEFAULT_MAX_CONTINUATIONS = 3;

function lastAssistantHitMaxOutput(messages: AppMessage[]): boolean {
	const lastMessage = messages[messages.length - 1];
	return (
		lastMessage?.role === "assistant" && lastMessage.stopReason === "length"
	);
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
		return { recovered: false, attempts: 0, exhausted: false };
	}

	let attempts = 0;

	while (
		attempts < maxContinuations &&
		lastAssistantHitMaxOutput(agent.state.messages)
	) {
		attempts += 1;
		options.onContinue?.(attempts, maxContinuations);
		logger.info("Continuing after max output stop", {
			attempt: attempts,
			maxContinuations,
		});
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
	};
}
