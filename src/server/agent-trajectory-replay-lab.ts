import type { ComposerRunTimelineResponse } from "@evalops/contracts";
import {
	type AgentTrajectoryInspectionReport,
	buildAgentTrajectoryInspectionReport,
} from "./agent-trajectory-inspection.js";
import {
	type AgentTrajectoryReplayReport,
	replayAgentTrajectoryReport,
} from "./agent-trajectory-replay.js";
import {
	type AgentTrajectoryScoreReport,
	type AgentTrajectoryScorerRule,
	scoreAgentTrajectoryReport,
} from "./agent-trajectory-scorers.js";
import {
	type AgentTrajectoryReport,
	buildAgentTrajectoryReport,
} from "./agent-trajectory.js";

export const AGENT_TRAJECTORY_REPLAY_LAB_SCHEMA =
	"evalops.maestro.agent-trajectory-replay-lab.v1";

export const DEFAULT_AGENT_TRAJECTORY_REPLAY_LAB_RULES: AgentTrajectoryScorerRule[] =
	[
		{
			id: "final-event-has-evidence",
			severity: "error",
			description:
				"The final answer or runtime terminal event must have evidence.",
			finalEvidenceCoverage: true,
		},
	];

export interface AgentTrajectoryReplayLabReport {
	schemaVersion: typeof AGENT_TRAJECTORY_REPLAY_LAB_SCHEMA;
	generatedAt: string;
	run: AgentTrajectoryReport["run"];
	summary: {
		timelineItems: number;
		trajectoryEvents: number;
		replayDeltas: number;
		replayErrors: number;
		replayWarnings: number;
		scoreRules: number;
		scoreFailures: number;
		scoreWarnings: number;
		jumpTargets: number;
		phases: number;
		toolCalls: number;
	};
	timeline: ComposerRunTimelineResponse;
	trajectory: AgentTrajectoryReport;
	replay: AgentTrajectoryReplayReport;
	score: AgentTrajectoryScoreReport;
	inspection: AgentTrajectoryInspectionReport;
}

export interface BuildAgentTrajectoryReplayLabOptions {
	rules?: AgentTrajectoryScorerRule[];
	generatedAt?: string;
}

export function buildAgentTrajectoryReplayLab(
	timeline: ComposerRunTimelineResponse,
	options: BuildAgentTrajectoryReplayLabOptions = {},
): AgentTrajectoryReplayLabReport {
	const trajectory = buildAgentTrajectoryReport(timeline);
	const replay = replayAgentTrajectoryReport(trajectory);
	const score = scoreAgentTrajectoryReport(
		trajectory,
		options.rules ?? DEFAULT_AGENT_TRAJECTORY_REPLAY_LAB_RULES,
	);
	const inspection = buildAgentTrajectoryInspectionReport({
		timelineItems: timeline.items,
		trajectory,
		replay,
		score,
	});
	return {
		schemaVersion: AGENT_TRAJECTORY_REPLAY_LAB_SCHEMA,
		generatedAt: options.generatedAt ?? new Date().toISOString(),
		run: trajectory.run,
		summary: {
			timelineItems: timeline.items.length,
			trajectoryEvents: trajectory.counts.events,
			replayDeltas: replay.counts.deltas,
			replayErrors: replay.counts.errors,
			replayWarnings: replay.counts.warnings,
			scoreRules: score.counts.rules,
			scoreFailures: score.counts.failed,
			scoreWarnings: score.counts.warnings,
			jumpTargets: inspection.counts.jumpTargets,
			phases: replay.counts.phases,
			toolCalls: replay.counts.toolCalls,
		},
		timeline,
		trajectory,
		replay,
		score,
		inspection,
	};
}
