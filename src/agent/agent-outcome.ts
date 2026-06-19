import type {
	AgentMode,
	ModelProvider,
	ResolvedSubagentDispatch,
} from "./modes.js";
import { resolveSubagentDispatch } from "./modes.js";
import type { SubagentType } from "./subagent-specs.js";

export const AGENT_OUTCOME_SCHEMA = "evalops.maestro.agent-outcome.v1";

export type AgentOutcomeSource =
	| "github-agent"
	| "mission"
	| "a2a"
	| "ambient-agent"
	| "trajectory";

export type AgentOutcomeStatus =
	| "succeeded"
	| "failed"
	| "changes_requested"
	| "merged"
	| "blocked";

export interface NormalizedAgentOutcome {
	schemaVersion: typeof AGENT_OUTCOME_SCHEMA;
	source: AgentOutcomeSource;
	taskId: string;
	repo?: string;
	taskType?: string;
	subagentType?: SubagentType;
	mode?: AgentMode;
	model?: string;
	provider?: ModelProvider;
	status: AgentOutcomeStatus;
	confidence?: number;
	durationMs?: number;
	tokensUsed?: number;
	costUsd?: number;
	labels: string[];
	failureReason?: string;
	recordedAt: string;
}

export interface AgentOutcomeInput
	extends Omit<
		NormalizedAgentOutcome,
		"schemaVersion" | "labels" | "recordedAt"
	> {
	labels?: string[];
	recordedAt?: string;
}

export interface AgentOutcomeSummary {
	total: number;
	successes: number;
	failures: number;
	successRate: number;
	bySubagent: Record<
		string,
		{
			total: number;
			successes: number;
			failures: number;
			successRate: number;
		}
	>;
	bestSubagent?: SubagentType;
	needsEscalation: boolean;
}

interface AgentOutcomeBucket {
	total: number;
	successes: number;
	failures: number;
	successRate: number;
}

export function normalizeAgentOutcome(
	input: AgentOutcomeInput,
): NormalizedAgentOutcome {
	return {
		schemaVersion: AGENT_OUTCOME_SCHEMA,
		...input,
		labels: uniqueStrings(input.labels ?? []),
		recordedAt: input.recordedAt ?? new Date().toISOString(),
	};
}

export function summarizeAgentOutcomes(
	outcomes: readonly NormalizedAgentOutcome[],
): AgentOutcomeSummary {
	const total = outcomes.length;
	const successes = outcomes.filter(isSuccessfulOutcome).length;
	const failures = total - successes;
	const bySubagent = new Map<string, AgentOutcomeBucket>();
	for (const outcome of outcomes) {
		if (!outcome.subagentType) continue;
		const current = bySubagent.get(outcome.subagentType) ?? {
			total: 0,
			successes: 0,
			failures: 0,
			successRate: 0,
		};
		current.total += 1;
		if (isSuccessfulOutcome(outcome)) {
			current.successes += 1;
		} else {
			current.failures += 1;
		}
		current.successRate = ratio(current.successes, current.total);
		bySubagent.set(outcome.subagentType, current);
	}
	const ranked = [...bySubagent.entries()]
		.filter(([, value]) => value.total >= 2)
		.sort(
			(left, right) =>
				right[1].successRate - left[1].successRate ||
				right[1].total - left[1].total ||
				left[0].localeCompare(right[0]),
		);
	return {
		total,
		successes,
		failures,
		successRate: ratio(successes, total),
		bySubagent: Object.fromEntries(bySubagent),
		bestSubagent: ranked[0]?.[0] as SubagentType | undefined,
		needsEscalation: total >= 3 && ratio(successes, total) < 0.5,
	};
}

export function resolveAdaptiveSubagentDispatch(input: {
	mode: AgentMode;
	subagentType: SubagentType;
	provider?: ModelProvider;
	outcomes?: readonly NormalizedAgentOutcome[];
}): ResolvedSubagentDispatch & {
	outcomeSummary?: AgentOutcomeSummary;
	adaptation:
		| "none"
		| "escalated-mode"
		| "best-known-subagent"
		| "escalated-mode-and-best-known-subagent";
} {
	const summary = input.outcomes
		? summarizeAgentOutcomes(input.outcomes)
		: undefined;
	const adaptedMode =
		summary?.needsEscalation === true && input.mode !== "frontier"
			? "frontier"
			: input.mode;
	const adaptedSubagent =
		comparableBestSubagent(input, summary) ?? input.subagentType;
	const dispatch = resolveSubagentDispatch(
		adaptedMode,
		adaptedSubagent,
		input.provider,
	);
	return {
		...dispatch,
		outcomeSummary: summary,
		adaptation: resolveAdaptation({
			modeChanged: adaptedMode !== input.mode,
			subagentChanged: adaptedSubagent !== input.subagentType,
		}),
	};
}

function resolveAdaptation(input: {
	modeChanged: boolean;
	subagentChanged: boolean;
}):
	| "none"
	| "escalated-mode"
	| "best-known-subagent"
	| "escalated-mode-and-best-known-subagent" {
	if (input.modeChanged && input.subagentChanged) {
		return "escalated-mode-and-best-known-subagent";
	}
	if (input.modeChanged) return "escalated-mode";
	if (input.subagentChanged) return "best-known-subagent";
	return "none";
}

function isSuccessfulOutcome(outcome: NormalizedAgentOutcome): boolean {
	return outcome.status === "succeeded" || outcome.status === "merged";
}

function comparableBestSubagent(
	input: {
		subagentType: SubagentType;
		outcomes?: readonly NormalizedAgentOutcome[];
	},
	summary: AgentOutcomeSummary | undefined,
): SubagentType | undefined {
	if (!summary || !input.outcomes) return undefined;

	const currentLaneOutcomes = input.outcomes.filter(
		(outcome) => outcome.subagentType === input.subagentType,
	);
	if (currentLaneOutcomes.length < 2) return undefined;
	const currentLaneFailures = currentLaneOutcomes.filter(
		(outcome) => !isSuccessfulOutcome(outcome),
	);
	if (currentLaneFailures.length < 2) return undefined;

	const currentTaskTypes = new Set(
		currentLaneFailures
			.map((outcome) => outcome.taskType?.trim())
			.filter((taskType): taskType is string => Boolean(taskType)),
	);
	if (currentTaskTypes.size === 0) return undefined;
	const currentComparableSummary = summarizeComparableOutcomes(
		input.outcomes,
		input.subagentType,
		currentTaskTypes,
	);
	if (currentComparableSummary.total === 0) return undefined;

	const comparableCandidates = new Set<SubagentType>();
	for (const outcome of input.outcomes) {
		const taskType = outcome.taskType?.trim();
		if (
			outcome.subagentType &&
			outcome.subagentType !== input.subagentType &&
			isSuccessfulOutcome(outcome) &&
			taskType !== undefined &&
			currentTaskTypes.has(taskType)
		) {
			comparableCandidates.add(outcome.subagentType);
		}
	}

	return [...comparableCandidates]
		.map((subagentType) => ({
			subagentType,
			summary: summarizeComparableOutcomes(
				input.outcomes ?? [],
				subagentType,
				currentTaskTypes,
			),
		}))
		.filter(
			(candidate) =>
				candidate.summary.successes > 0 &&
				candidate.summary.successRate > currentComparableSummary.successRate,
		)
		.sort(
			(left, right) =>
				right.summary.successRate - left.summary.successRate ||
				right.summary.total - left.summary.total ||
				left.subagentType.localeCompare(right.subagentType),
		)[0]?.subagentType;
}

function summarizeComparableOutcomes(
	outcomes: readonly NormalizedAgentOutcome[],
	subagentType: SubagentType,
	taskTypes: ReadonlySet<string>,
): AgentOutcomeBucket {
	const matching = outcomes.filter((outcome) => {
		const taskType = outcome.taskType?.trim();
		return (
			outcome.subagentType === subagentType &&
			taskType !== undefined &&
			taskTypes.has(taskType)
		);
	});
	const successes = matching.filter(isSuccessfulOutcome).length;
	const total = matching.length;
	return {
		total,
		successes,
		failures: total - successes,
		successRate: ratio(successes, total),
	};
}

function ratio(numerator: number, denominator: number): number {
	return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));
}

function uniqueStrings(values: readonly string[]): string[] {
	return Array.from(
		new Set(values.map((value) => value.trim()).filter(Boolean)),
	);
}
