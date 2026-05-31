import type { AgentEvent, ToolSchedulingDecision } from "../types.js";

export type ToolPhaseSummaryEvent = Extract<
	AgentEvent,
	{ type: "tool_phase_summary" }
>;

export function buildToolPhaseSummaryEvent(
	decisionsByToolCall: Iterable<ToolSchedulingDecision>,
): ToolPhaseSummaryEvent | undefined {
	const rawDecisions = [...decisionsByToolCall].sort(
		(left, right) => left.emittedIndex - right.emittedIndex,
	);
	if (rawDecisions.length === 0) {
		return undefined;
	}

	const waveCounts = new Map<number, number>();
	for (const decision of rawDecisions) {
		if (decision.waveIndex !== undefined) {
			waveCounts.set(
				decision.waveIndex,
				(waveCounts.get(decision.waveIndex) ?? 0) + 1,
			);
		}
	}

	const decisions: ToolPhaseSummaryEvent["decisions"] = rawDecisions.map(
		(decision) => {
			const isSingleModelToolCall = rawDecisions.length === 1;
			const waveSize =
				decision.waveIndex !== undefined
					? (waveCounts.get(decision.waveIndex) ?? 1)
					: 1;
			const outcome =
				decision.cacheHit === true
					? "cached"
					: decision.decision === "skipped"
						? "skipped"
						: decision.decision === "delayed" ||
								decision.blockedByMutation === true
							? "delayed"
							: decision.decision === "parallelized" ||
									(waveSize > 1 && decision.decision === "scheduled")
								? "parallelized"
								: "serialized";
			const reason =
				outcome === "cached"
					? "cache_hit"
					: decision.blockedByMutation === true
						? decision.reason
						: decision.reason === "workflow_state_serialized"
							? "workflow_state_serialized"
							: decision.mcpOptIn === true
								? "mcp_parallel_opt_in"
								: decision.reason.startsWith("read_only")
									? outcome === "parallelized"
										? "read_only_parallel_safe"
										: isSingleModelToolCall
											? "single_read_only_call"
											: decision.reason
									: decision.reason.startsWith("path_scoped_mutation")
										? "path_scoped_mutation"
										: decision.reason;
			return {
				toolCallId: decision.callId,
				toolName: decision.toolName,
				emittedIndex: decision.emittedIndex,
				outcome,
				decision: outcome,
				reason,
				waveIndex:
					decision.waveIndex !== undefined
						? Math.max(0, decision.waveIndex - 1)
						: undefined,
				waitMs: Math.max(0, Math.round(decision.schedulerWaitMs ?? 0)),
				schedulerWaitMs: Math.max(0, Math.round(decision.schedulerWaitMs ?? 0)),
				mcpOptIn: decision.mcpOptIn,
				cacheHit: decision.cacheHit,
				blockedByMutation: decision.blockedByMutation,
			};
		},
	);

	const parallelizedCallCount = decisions.filter(
		(decision) => decision.outcome === "parallelized",
	).length;
	const delayedCallCount = decisions.filter(
		(decision) => decision.outcome === "delayed",
	).length;
	const batchShapingFeedback =
		decisions.length === 1 && decisions[0]?.reason === "single_read_only_call"
			? {
					avoidableSingleton: true,
					reason: "single_read_only_call",
					hint: "When you need several independent reads or searches, emit them together in one assistant message so Maestro can batch them safely.",
				}
			: undefined;
	const serializationReasons = Object.fromEntries(
		[...decisions]
			.filter(
				(decision) =>
					decision.outcome === "serialized" || decision.outcome === "delayed",
			)
			.reduce((counts, decision) => {
				counts.set(decision.reason, (counts.get(decision.reason) ?? 0) + 1);
				return counts;
			}, new Map<string, number>()),
	);

	return {
		type: "tool_phase_summary",
		modelToolCallCount: rawDecisions.length,
		modelEmittedToolCallCount: rawDecisions.length,
		schedulableWaveCount: waveCounts.size,
		parallelizedCallCount,
		actuallyParallelizedCallCount: parallelizedCallCount,
		serializedCallCount: decisions.filter(
			(decision) =>
				decision.outcome === "serialized" || decision.outcome === "delayed",
		).length,
		delayedCallCount,
		blockedByMutationCount: decisions.filter(
			(decision) => decision.blockedByMutation === true,
		).length,
		mcpOptInCallCount: decisions.filter(
			(decision) => decision.mcpOptIn === true,
		).length,
		mcpOptInUseCount: decisions.filter((decision) => decision.mcpOptIn === true)
			.length,
		cacheHitCount: decisions.filter((decision) => decision.cacheHit === true)
			.length,
		totalToolWaitMs: decisions.reduce(
			(total, decision) => total + decision.waitMs,
			0,
		),
		toolWaitTimeMs: decisions.reduce(
			(total, decision) => total + decision.waitMs,
			0,
		),
		serializationReasons,
		decisions,
		batchShapingFeedback,
	};
}
