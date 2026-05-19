export interface CodexSubagentDispatchLane {
	laneId: string;
	skillId: string;
	displayName: string;
	description: string;
	tags: readonly string[];
	typeAliases: readonly string[];
	capabilityAliases: readonly string[];
}

export interface CodexSubagentDispatchTable {
	schemaVersion: "evalops.maestro.codex.subagent-dispatch-table.v1";
	defaultCapability: "code:write";
	a2aSkillLanes: readonly CodexSubagentDispatchLane[];
}

export const CODEX_SUBAGENT_DISPATCH_TABLE = {
	schemaVersion: "evalops.maestro.codex.subagent-dispatch-table.v1",
	defaultCapability: "code:write",
	a2aSkillLanes: [
		{
			laneId: "code-writer",
			skillId: "maestro.subagent.code-writer",
			displayName: "Maestro code writer subagent",
			description:
				"Delegate bounded implementation work to a target-owned Maestro coding child agent.",
			tags: ["maestro", "subagent", "code", "write"],
			typeAliases: ["worker", "coder", "code", "code-writer", "default"],
			capabilityAliases: [
				"code:write",
				"code-write",
				"code:edit",
				"code-edit",
				"code:implement",
				"code-implement",
			],
		},
		{
			laneId: "code-review",
			skillId: "maestro.subagent.code-review",
			displayName: "Maestro code review subagent",
			description:
				"Delegate code review and risk analysis to a target-owned Maestro review child agent.",
			tags: ["maestro", "subagent", "code", "review"],
			typeAliases: [
				"pr-review",
				"review",
				"reviewer",
				"code-review",
				"code-reviewer",
			],
			capabilityAliases: ["code:review", "code-review"],
		},
		{
			laneId: "test-runner",
			skillId: "maestro.subagent.test-runner",
			displayName: "Maestro test runner subagent",
			description:
				"Delegate test execution, failure triage, and verification evidence capture to a target-owned Maestro child agent.",
			tags: ["maestro", "subagent", "test", "ci"],
			typeAliases: ["test", "qa", "ci", "ci-monitor", "test-runner"],
			capabilityAliases: [
				"code:test",
				"code-test",
				"test:run",
				"test-run",
				"test-runner",
			],
		},
		{
			laneId: "repo-explorer",
			skillId: "maestro.subagent.repo-explorer",
			displayName: "Maestro repo explorer subagent",
			description:
				"Delegate repository inspection and context gathering to a target-owned Maestro exploration child agent.",
			tags: ["maestro", "subagent", "repo", "explore"],
			typeAliases: [
				"explore",
				"explorer",
				"repo-explorer",
				"research",
				"competitive-intel",
				"people-research",
			],
			capabilityAliases: [
				"repo:explore",
				"repo-explore",
				"repo-explorer",
				"code:search",
				"code-search",
			],
		},
		{
			laneId: "release-shepherd",
			skillId: "maestro.subagent.release-shepherd",
			displayName: "Maestro release shepherd subagent",
			description:
				"Delegate release, rollout, and merge-follow-through work to a target-owned Maestro child agent.",
			tags: ["maestro", "subagent", "release", "deploy"],
			typeAliases: ["release", "release-shepherd"],
			capabilityAliases: [
				"release:shepherd",
				"release-shepherd",
				"release:manage",
				"release-manage",
			],
		},
	],
} as const satisfies CodexSubagentDispatchTable;

export const DEFAULT_CODEX_SUBAGENT_DELEGATION_CAPABILITY =
	CODEX_SUBAGENT_DISPATCH_TABLE.defaultCapability;

function tokenSet(values: readonly string[]): ReadonlySet<string> {
	return new Set(
		values
			.map((value) => codexSubagentSkillToken(value))
			.filter((token): token is string => Boolean(token)),
	);
}

const lanesByTypeToken = new Map(
	CODEX_SUBAGENT_DISPATCH_TABLE.a2aSkillLanes.flatMap((lane) =>
		Array.from(tokenSet(lane.typeAliases), (token) => [token, lane] as const),
	),
);

const lanesByCapabilityToken = new Map(
	CODEX_SUBAGENT_DISPATCH_TABLE.a2aSkillLanes.flatMap((lane) =>
		Array.from(
			tokenSet(lane.capabilityAliases),
			(token) => [token, lane] as const,
		),
	),
);

export function codexSubagentLaneForType(
	value: string | undefined,
): CodexSubagentDispatchLane | undefined {
	const token = codexSubagentSkillToken(value);
	return token ? lanesByTypeToken.get(token) : undefined;
}

export function codexSubagentLaneForCapability(
	value: string | undefined,
): CodexSubagentDispatchLane | undefined {
	const token = codexSubagentSkillToken(value);
	return token ? lanesByCapabilityToken.get(token) : undefined;
}

export function codexSubagentTypeA2ASkillID(
	value: string | undefined,
): string | undefined {
	return codexSubagentA2ASkillID(
		value,
		codexSubagentLaneForType(value)?.skillId,
	);
}

export function codexSubagentCapabilityA2ASkillID(
	value: string | undefined,
): string | undefined {
	return codexSubagentA2ASkillID(
		value,
		codexSubagentLaneForCapability(value)?.skillId,
	);
}

export function codexSubagentSkillToken(
	value: string | undefined,
): string | undefined {
	const token = value
		?.trim()
		.toLowerCase()
		.replace(/[:_/. ]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-|-$/g, "");
	return token || undefined;
}

function codexSubagentA2ASkillID(
	value: string | undefined,
	mappedSkillId: string | undefined,
): string | undefined {
	const token = codexSubagentSkillToken(value);
	if (!token) {
		return undefined;
	}
	return mappedSkillId ?? `maestro.subagent.${token}`;
}
