import type { Agent } from "./agent.js";
import type { AgentRunConfig } from "./types.js";

type CurrentTaskBudget = NonNullable<AgentRunConfig["taskBudget"]>;

export function setTaskBudgetTotal(
	agent: Agent,
	total: number | undefined,
): void {
	(
		agent as Agent & {
			setTaskBudgetTotal?: (total: number | undefined) => void;
		}
	).setTaskBudgetTotal?.(total);
}

export function getTaskBudgetTotal(agent: Agent): number | undefined {
	return typeof (
		agent as Agent & {
			getTaskBudgetTotal?: () => number | undefined;
		}
	).getTaskBudgetTotal === "function"
		? (
				agent as Agent & {
					getTaskBudgetTotal: () => number | undefined;
				}
			).getTaskBudgetTotal()
		: undefined;
}

export function setCurrentTaskBudget(
	agent: Agent,
	taskBudget: CurrentTaskBudget | undefined,
): void {
	(
		agent as Agent & {
			setCurrentTaskBudget?: (
				taskBudget: CurrentTaskBudget | undefined,
			) => void;
		}
	).setCurrentTaskBudget?.(taskBudget);
}

export function getCurrentTaskBudget(
	agent: Agent,
): CurrentTaskBudget | undefined {
	return typeof (
		agent as Agent & {
			getCurrentTaskBudget?: () => CurrentTaskBudget | undefined;
		}
	).getCurrentTaskBudget === "function"
		? (
				agent as Agent & {
					getCurrentTaskBudget: () => CurrentTaskBudget | undefined;
				}
			).getCurrentTaskBudget()
		: undefined;
}
