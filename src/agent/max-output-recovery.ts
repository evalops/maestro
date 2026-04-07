import type { Agent } from "./agent.js";
import {
	type MaxOutputRecoveryResult,
	recoverFromMaxOutput as recoverFromPromptRecovery,
} from "./prompt-recovery.js";

export interface MaxOutputRecoveryOptions {
	enabled?: boolean;
	maxContinuations?: number;
	onContinue?: (attempt: number, maxContinuations: number) => void;
	onExhausted?: (maxContinuations: number) => void;
	onStoppedEarly?: (attempt: number, maxContinuations: number) => void;
}

export type { MaxOutputRecoveryResult };

export async function recoverFromMaxOutput(
	agent: Pick<Agent, "state" | "continue">,
	options: MaxOutputRecoveryOptions = {},
): Promise<MaxOutputRecoveryResult> {
	if ((options.enabled ?? true) === false) {
		return {
			recovered: false,
			attempts: 0,
			exhausted: false,
			stoppedEarly: false,
		};
	}

	const recoveryAgent = {
		continue: agent.continue.bind(agent),
		get state() {
			return {
				...agent.state,
				model:
					(
						agent.state as Agent["state"] & {
							model?: Agent["state"]["model"];
						}
					).model ??
					({
						provider: "openai",
						maxTokens: Number.MAX_SAFE_INTEGER,
					} as Agent["state"]["model"]),
			};
		},
	} as Agent;

	return recoverFromPromptRecovery(recoveryAgent, {
		maxContinuations: options.maxContinuations,
		callbacks: {
			onMaxOutputContinue: options.onContinue,
			onMaxOutputExhausted: options.onExhausted,
			onMaxOutputStoppedEarly: options.onStoppedEarly,
		},
	});
}
