import type { AgentTrajectoryScorerRule } from "../src/server/agent-trajectory-scorers.js";

export const defaultTrajectoryFixtureRules: AgentTrajectoryScorerRule[] = [
	{
		id: "final-event-has-evidence",
		severity: "error",
		description: "The final answer or runtime terminal event must have evidence.",
		finalEvidenceCoverage: true,
	},
];

const rulesByFixture: Record<string, AgentTrajectoryScorerRule[]> = {
	"session-replay/legacy-compacted-mcp-session.jsonl": [
		...defaultTrajectoryFixtureRules,
		{
			id: "legacy-mcp-search-requested",
			severity: "error",
			description: "Legacy MCP fixture should request platform search.",
			anyEvent: {
				type: "tool.requested",
				toolName: "mcp__platform__search",
			},
		},
		{
			id: "legacy-no-policy-decision",
			severity: "error",
			description: "Legacy fixture should not synthesize policy decisions.",
			forbidEvent: { type: "policy.decision" },
		},
	],
	"session-replay/local-diagnostic-artifact-session.jsonl": [
		...defaultTrajectoryFixtureRules,
		{
			id: "local-diagnostic-delta",
			severity: "error",
			description: "Local diagnostic fixture should include diagnostic delta.",
			anyEvent: { type: "diagnostic.delta", status: "failed" },
		},
		{
			id: "local-skill-artifact-linked",
			severity: "error",
			description: "Local diagnostic fixture should link skill artifact.",
			requireArtifact: {
				toolCallId: "call-local-edit",
				artifactId: "skill_artifact_local_1",
			},
		},
		{
			id: "local-governance-recorded",
			severity: "error",
			description: "Local diagnostic fixture should preserve governance.",
			anyEvent: { type: "policy.decision", status: "pending" },
		},
	],
	"agent-trajectory/hosted-governed-recovery.timeline.json": [
		...defaultTrajectoryFixtureRules,
		{
			id: "hosted-platform-backed",
			severity: "error",
			description: "Hosted fixture must stay platform sourced.",
			forbidEvent: { source: "local" },
		},
		{
			id: "hosted-approval-before-result",
			severity: "error",
			description: "Hosted restart must wait for approval before terminal result.",
			approvalBeforeToolResult: { toolCallId: "call-hosted-restart" },
		},
		{
			id: "hosted-recovery-after-failure",
			severity: "warning",
			description: "Hosted restart failure should be followed by recovery.",
			recoveryAfterFailedTool: { toolCallId: "call-hosted-restart" },
		},
		{
			id: "hosted-read-artifact",
			severity: "error",
			description: "Hosted read should link recovery artifact.",
			requireArtifact: {
				toolCallId: "call-hosted-read",
				artifactId: "skill_artifact_hosted_1",
			},
		},
	],
	"agent-trajectory/codex-subagent-handoff.timeline.json": [
		...defaultTrajectoryFixtureRules,
		{
			id: "codex-child-agent-completed",
			severity: "error",
			description: "Codex subagent handoff must preserve child-run completion.",
			childRunCompleted: {
				parentAgentRunId: "agent-run-parent-codex-1",
				childAgentRunId: "agent-run-child-codex-1",
			},
		},
		{
			id: "codex-subagent-spawn-recorded",
			severity: "error",
			description: "Codex subagent handoff must record the spawn provider tool.",
			anyEvent: {
				type: "tool.requested",
				toolName: "codex.subagent.spawnAgent",
			},
		},
		{
			id: "codex-subagent-wait-recorded",
			severity: "error",
			description: "Codex subagent handoff must record the wait provider tool.",
			anyEvent: {
				type: "tool.requested",
				toolName: "codex.subagent.wait",
			},
		},
	],
};

export function rulesForTrajectoryFixture(
	name: string,
): AgentTrajectoryScorerRule[] {
	return rulesByFixture[name] ?? defaultTrajectoryFixtureRules;
}
