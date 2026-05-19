import {
	CODEX_SUBAGENT_DISPATCH_TABLE,
	type CodexSubagentDispatchLane,
} from "../codex/subagent-dispatch-table.js";
import type {
	PlatformAgentA2APeerProjection,
	PlatformAgentA2ASkill,
} from "./agent-registry-client.js";

export const MAESTRO_A2A_PROTOCOL_VERSION = "1.0";
export const MAESTRO_A2A_PROTOCOL_BINDING = "HTTP+JSON";
export const MAESTRO_A2A_AGENT_CARD_PATH = "/.well-known/agent-card.json";
export const EVALOPS_A2A_OPERATING_PLANE_EXTENSION_URI =
	"https://evalops.com/a2a/extensions/operating-plane/v1";

const MAESTRO_TUI_TURN_SKILL: PlatformAgentA2ASkill = {
	id: "maestro-tui-turn",
	name: "Maestro TUI turn",
	description:
		"Run a prompt through the local Maestro native TUI agent runner.",
	tags: ["maestro", "tui", "codex", "a2a", "fleet"],
	inputModes: ["text/plain"],
	outputModes: ["text/plain", "application/json"],
	attributes: {
		evalopsSkillKind: "maestro-turn",
		operatingPlaneExtension: EVALOPS_A2A_OPERATING_PLANE_EXTENSION_URI,
	},
};

export interface BuildMaestroA2APeerProjectionInput {
	publicEndpointUrl: string;
	internalEndpointUrl?: string;
	agentCardUrl?: string;
	protocolVersion?: string;
	agentCardETag?: string;
	agentCardHash?: string;
	pushNotifications?: boolean;
	securitySchemes?: string[];
	attributes?: Record<string, string>;
}

export function defaultMaestroA2ACapabilities(): string[] {
	return uniqueStrings([
		"maestro:a2a",
		"maestro:cli",
		"maestro:subagents",
		...CODEX_SUBAGENT_DISPATCH_TABLE.a2aSkillLanes.flatMap((lane) =>
			lane.capabilityAliases.filter((capability) => capability.includes(":")),
		),
	]);
}

export function buildMaestroA2APeerProjection(
	input: BuildMaestroA2APeerProjectionInput,
): PlatformAgentA2APeerProjection {
	const publicEndpointUrl = normalizeEndpoint(input.publicEndpointUrl);
	const internalEndpointUrl = input.internalEndpointUrl
		? normalizeEndpoint(input.internalEndpointUrl)
		: undefined;
	const agentCardUrl =
		input.agentCardUrl?.trim() ||
		`${publicEndpointUrl}${MAESTRO_A2A_AGENT_CARD_PATH}`;
	return stripUndefinedValues({
		publicEndpointUrl,
		internalEndpointUrl,
		agentCardUrl,
		protocolBinding: MAESTRO_A2A_PROTOCOL_BINDING,
		protocolVersion: input.protocolVersion ?? MAESTRO_A2A_PROTOCOL_VERSION,
		supportedExtensions: [EVALOPS_A2A_OPERATING_PLANE_EXTENSION_URI],
		skills: maestroA2AAgentSkills(),
		securitySchemes:
			input.securitySchemes && input.securitySchemes.length > 0
				? uniqueStrings(input.securitySchemes)
				: ["evalops-agent-token"],
		agentCardETag: input.agentCardETag,
		agentCardHash: input.agentCardHash,
		pushNotifications: input.pushNotifications ?? true,
		attributes: {
			runtime: "maestro",
			controlPlane: "rust-control-plane",
			subagentDispatchTable: CODEX_SUBAGENT_DISPATCH_TABLE.schemaVersion,
			operatingPlaneExtension: EVALOPS_A2A_OPERATING_PLANE_EXTENSION_URI,
			...(input.attributes ?? {}),
		},
	}) as PlatformAgentA2APeerProjection;
}

export function maestroA2AAgentSkills(): PlatformAgentA2ASkill[] {
	return [
		MAESTRO_TUI_TURN_SKILL,
		...CODEX_SUBAGENT_DISPATCH_TABLE.a2aSkillLanes.map(
			maestroSubagentLaneSkill,
		),
	];
}

function maestroSubagentLaneSkill(
	lane: CodexSubagentDispatchLane,
): PlatformAgentA2ASkill {
	const policy = laneSkillPolicy(lane.laneId);
	return {
		id: lane.skillId,
		name: lane.displayName,
		description: lane.description,
		tags: [...lane.tags],
		inputModes: ["text/plain", "application/json"],
		outputModes: ["text/plain", "application/json"],
		requiredContextGrants: policy.requiredContextGrants,
		approvalPolicyRef: `maestro.subagent.${lane.laneId}.target-policy`,
		maxAutonomy: "bounded",
		requiredArtifactKinds: policy.requiredArtifactKinds,
		optionalArtifactKinds: policy.optionalArtifactKinds,
		allowedTaskClasses: policy.allowedTaskClasses,
		deniedTaskClasses: [
			"credential.materialization",
			"secret.exfiltration",
			"unbounded.repository.write",
		],
		attributes: {
			evalopsSkillKind: "maestro-subagent",
			subagentLaneId: lane.laneId,
			requestMetadataPath: "evalops.subagentRequest",
			operatingPlaneExtension: EVALOPS_A2A_OPERATING_PLANE_EXTENSION_URI,
		},
		metadata: {
			evalopsSkillKind: "maestro-subagent",
			subagentLaneId: lane.laneId,
			operatingPlaneExtension: EVALOPS_A2A_OPERATING_PLANE_EXTENSION_URI,
			requestMetadataPath: "evalops.subagentRequest",
			approvalPolicy: "target-maestro-policy",
			contextGrantPolicy: "bounded-policy-grants",
			resultPolicy: "summary-and-artifacts",
			workGraph: "target AgentRun child-agent work items",
		},
	};
}

function laneSkillPolicy(laneId: string): {
	requiredContextGrants: string[];
	requiredArtifactKinds: string[];
	optionalArtifactKinds: string[];
	allowedTaskClasses: string[];
} {
	switch (laneId) {
		case "code-writer":
			return {
				requiredContextGrants: [
					"repo:read",
					"repo:write-scoped",
					"tool:execute-tests",
				],
				requiredArtifactKinds: ["patch.summary"],
				optionalArtifactKinds: ["test.report", "review.summary"],
				allowedTaskClasses: ["code.implementation", "code.refactor"],
			};
		case "code-review":
			return {
				requiredContextGrants: [
					"repo:read",
					"pull-request:read",
					"evidence:read",
				],
				requiredArtifactKinds: ["review.summary"],
				optionalArtifactKinds: ["risk.finding", "test.plan"],
				allowedTaskClasses: ["code.review", "risk.analysis"],
			};
		case "test-runner":
			return {
				requiredContextGrants: [
					"repo:read",
					"tool:execute-tests",
					"evidence:write",
				],
				requiredArtifactKinds: ["test.report"],
				optionalArtifactKinds: ["failure.triage", "coverage.summary"],
				allowedTaskClasses: ["test.execution", "ci.triage"],
			};
		case "repo-explorer":
			return {
				requiredContextGrants: ["repo:read", "evidence:write"],
				requiredArtifactKinds: ["repo.map"],
				optionalArtifactKinds: ["evidence.index"],
				allowedTaskClasses: ["repo.inspect", "context.gathering"],
			};
		case "release-shepherd":
			return {
				requiredContextGrants: [
					"repo:read",
					"pull-request:write",
					"deploy:read",
					"evidence:write",
				],
				requiredArtifactKinds: ["release.evidence"],
				optionalArtifactKinds: ["ci.summary", "deploy.status"],
				allowedTaskClasses: ["release.follow-through", "deployment.smoke"],
			};
		default:
			return {
				requiredContextGrants: ["repo:read"],
				requiredArtifactKinds: ["subagent.summary"],
				optionalArtifactKinds: ["evidence.index"],
				allowedTaskClasses: ["agent.delegation"],
			};
	}
}

function normalizeEndpoint(value: string): string {
	const endpoint = value.trim().replace(/\/+$/u, "");
	if (!endpoint) {
		throw new Error("A2A endpoint URL is required");
	}
	return endpoint;
}

function uniqueStrings(values: readonly string[]): string[] {
	return Array.from(
		new Set(values.map((value) => value.trim()).filter(Boolean)),
	);
}

function stripUndefinedValues(
	record: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(record).filter(([, value]) => value !== undefined),
	);
}
