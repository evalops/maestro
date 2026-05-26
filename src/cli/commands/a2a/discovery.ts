import chalk from "chalk";
import {
	type A2APeerRegistryEntry,
	normalizePeerName,
} from "../../../platform/a2a-peer-registry.js";
import type {
	PlatformAgentDiscoveryEvidence,
	PlatformAgentRegistryA2APeerCandidate,
} from "../../../platform/agent-registry-client.js";

export interface A2ADiscoverySelection {
	source: "platform-agent-registry";
	evidence?: PlatformAgentDiscoveryEvidence;
	candidateCount: number;
	matchedCount: number;
	selectedAgentId?: string;
	selectedAgentName?: string;
	selectedEndpointUrl?: string;
	selectedEndpointKind?: "public" | "internal";
	score?: number;
	reasons?: string[];
}

export function printA2ADiscoveryEvidence(
	evidence: PlatformAgentDiscoveryEvidence | undefined,
): void {
	if (!evidence) {
		return;
	}
	const summary = [
		evidence.decision ? `decision=${evidence.decision}` : undefined,
		evidence.reason ? `reason=${evidence.reason}` : undefined,
		evidence.matchedCount !== undefined
			? `matched=${evidence.matchedCount}`
			: undefined,
		evidence.candidateCount !== undefined
			? `candidates=${evidence.candidateCount}`
			: undefined,
		evidence.a2aSkillId ? `skill=${evidence.a2aSkillId}` : undefined,
		evidence.capability ? `capability=${evidence.capability}` : undefined,
	]
		.filter(Boolean)
		.join(" ");
	if (summary) {
		console.log(chalk.dim(`  discovery ${summary}`));
	}
	if (evidence.exclusions?.length) {
		const exclusions = evidence.exclusions
			.map((exclusion) =>
				[
					exclusion.reason,
					exclusion.count !== undefined ? `count=${exclusion.count}` : "",
				]
					.filter(Boolean)
					.join(":"),
			)
			.filter(Boolean)
			.join(", ");
		if (exclusions) {
			console.log(chalk.dim(`  exclusions ${exclusions}`));
		}
	}
}

export function discoveredPeerJson(
	candidate: PlatformAgentRegistryA2APeerCandidate,
): {
	agentId?: string;
	name?: string;
	status?: string;
	endpointUrl: string;
	endpointKind?: "public" | "internal";
	agentCardUrl?: string;
	protocolBinding?: string;
	protocolVersion?: string;
	skills: PlatformAgentRegistryA2APeerCandidate["skills"];
	supportedExtensions?: string[];
	pushNotifications?: boolean;
} {
	return {
		...(candidate.agent.id ? { agentId: candidate.agent.id } : {}),
		...(candidate.agent.name ? { name: candidate.agent.name } : {}),
		...(candidate.agent.status ? { status: candidate.agent.status } : {}),
		endpointUrl: candidate.endpointUrl,
		...(candidate.endpointKind ? { endpointKind: candidate.endpointKind } : {}),
		...(candidate.agentCardUrl ? { agentCardUrl: candidate.agentCardUrl } : {}),
		...(candidate.protocolBinding
			? { protocolBinding: candidate.protocolBinding }
			: {}),
		...(candidate.protocolVersion
			? { protocolVersion: candidate.protocolVersion }
			: {}),
		skills: candidate.skills,
		...(candidate.supportedExtensions
			? { supportedExtensions: candidate.supportedExtensions }
			: {}),
		...(candidate.pushNotifications === undefined
			? {}
			: { pushNotifications: candidate.pushNotifications }),
	};
}

export function discoveredPeerName(
	candidate: PlatformAgentRegistryA2APeerCandidate,
	index: number,
): string {
	const raw =
		candidate.agent.id ??
		candidate.agent.name ??
		`platform-a2a-peer-${index + 1}`;
	const sanitized =
		raw
			.trim()
			.replace(/[^A-Za-z0-9_.-]+/gu, "-")
			.replace(/^-+|-+$/gu, "")
			.slice(0, 80) || `platform-a2a-peer-${index + 1}`;
	return normalizePeerName(sanitized);
}

export function uniqueDiscoveredPeerName(input: {
	baseName: string;
	candidate: PlatformAgentRegistryA2APeerCandidate;
	importedNames: Set<string>;
	peers: Record<string, A2APeerRegistryEntry>;
}): string {
	for (let suffix = 1; suffix <= 100; suffix++) {
		const name =
			suffix === 1 ? input.baseName : suffixedPeerName(input.baseName, suffix);
		const existing = input.peers[name];
		const hasSameAgentId = Boolean(
			existing?.agentId &&
				input.candidate.agent.id &&
				existing.agentId === input.candidate.agent.id,
		);
		const hasSameEndpoint = existing?.url === input.candidate.endpointUrl;
		if (
			!input.importedNames.has(name) &&
			(!existing || hasSameAgentId || hasSameEndpoint)
		) {
			input.importedNames.add(name);
			return name;
		}
	}
	throw new Error(
		`Could not derive a unique A2A peer name for ${input.baseName}`,
	);
}

function suffixedPeerName(baseName: string, suffix: number): string {
	const suffixText = `-${suffix}`;
	return normalizePeerName(
		`${baseName.slice(0, 80 - suffixText.length)}${suffixText}`,
	);
}

export function a2ADiscoveryEvidenceMetadata(
	evidence: PlatformAgentDiscoveryEvidence | undefined,
): Record<string, string | number | boolean> {
	if (!evidence) {
		return {};
	}
	return (
		compactA2APeerMetadata({
			platformDiscoverySchema: evidence.schema,
			platformDiscoveryDecision: evidence.decision,
			platformDiscoveryReason: evidence.reason,
			platformDiscoveryWorkspaceId: evidence.workspaceId,
			platformDiscoveryCapability: evidence.capability,
			platformDiscoveryAgentType: evidence.agentType,
			platformDiscoveryA2ASkillId: evidence.a2aSkillId,
			platformDiscoveryTaskClass: evidence.taskClass,
			platformDiscoveryRequireA2ADispatch: evidence.requireA2ADispatch,
			platformDiscoverySurface: evidence.surface,
			platformDiscoveryStatus: evidence.status,
			platformDiscoveryCandidateCount: evidence.candidateCount,
			platformDiscoveryMatchedCount: evidence.matchedCount,
		}) ?? {}
	);
}

export function a2APeerMetadataWithoutDiscoveryEvidence(
	metadata: A2APeerRegistryEntry["metadata"] | undefined,
): Record<string, string | number | boolean> | undefined {
	if (!metadata) {
		return undefined;
	}
	const entries = Object.entries(metadata).filter(
		([key]) => !key.startsWith("platformDiscovery"),
	);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function a2ADiscoverySelectionPayload(
	selection: A2ADiscoverySelection | undefined,
): Record<string, unknown> | undefined {
	if (!selection) {
		return undefined;
	}
	return compactA2AUnknownRecord({
		source: selection.source,
		...a2ADiscoveryEvidenceMetadata(selection.evidence),
		selectedAgentId: selection.selectedAgentId,
		selectedAgentName: selection.selectedAgentName,
		selectedEndpointUrl: selection.selectedEndpointUrl,
		selectedEndpointKind: selection.selectedEndpointKind,
		score: selection.score,
		reasons: selection.reasons,
		candidateCount: selection.candidateCount,
		matchedCount: selection.matchedCount,
	});
}

function compactA2AUnknownRecord(
	record: Record<string, unknown>,
): Record<string, unknown> | undefined {
	const entries = Object.entries(record).filter(([, value]) => {
		if (value === undefined) {
			return false;
		}
		return !Array.isArray(value) || value.length > 0;
	});
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function compactA2APeerMetadata(
	record: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> | undefined {
	const entries = Object.entries(record).filter(
		(entry): entry is [string, string | number | boolean] =>
			entry[1] !== undefined,
	);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
