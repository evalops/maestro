import type {
	PlatformAgentA2ASkill,
	PlatformAgentRegistryA2APeerCandidate,
} from "./agent-registry-client.js";

export const A2A_CAPABILITY_MARKET_VERSION =
	"evalops.maestro.a2a-capability-market.v1";

export interface A2ACapabilityMarketRequest {
	skillId?: string;
	taskClass?: string;
	requiredContextGrants?: string[];
	requiredArtifactKinds?: string[];
	preferInternalEndpoint?: boolean;
	now?: Date;
}

export interface A2ACapabilityMarketRank {
	version: typeof A2A_CAPABILITY_MARKET_VERSION;
	candidate: PlatformAgentRegistryA2APeerCandidate;
	selectedSkill?: PlatformAgentA2ASkill;
	score: number;
	reasons: string[];
	blockers: string[];
}

interface A2ACapabilitySkillRank {
	selectedSkill?: PlatformAgentA2ASkill;
	score: number;
	reasons: string[];
	blockers: string[];
}

function normalizedSet(values: string[] | undefined): Set<string> {
	return new Set((values ?? []).map((value) => value.trim()).filter(Boolean));
}

function hasRequestedValues(values: string[] | undefined): boolean {
	return (values ?? []).some((value) => value.trim().length > 0);
}

function hasAll(
	required: string[] | undefined,
	available: string[] | undefined,
) {
	const availableSet = normalizedSet(available);
	return [...normalizedSet(required)].every((value) => availableSet.has(value));
}

function statusScore(status: string | undefined): {
	score: number;
	reason: string;
} {
	const normalized = status?.toUpperCase();
	if (normalized?.includes("IDLE")) {
		return { score: 30, reason: "status_idle" };
	}
	if (
		normalized === "ACTIVE" ||
		normalized === "AGENT_STATUS_ACTIVE" ||
		normalized?.includes("ONLINE") ||
		normalized?.includes("READY")
	) {
		return { score: 20, reason: "status_online" };
	}
	if (normalized?.includes("BUSY")) {
		return { score: 5, reason: "status_busy" };
	}
	return { score: 0, reason: "status_unknown" };
}

function heartbeatScore(
	lastHeartbeatAt: string | undefined,
	now: Date,
): { score: number; reason?: string } {
	if (!lastHeartbeatAt) {
		return { score: 0 };
	}
	const ageMs = now.getTime() - Date.parse(lastHeartbeatAt);
	if (!Number.isFinite(ageMs) || ageMs < 0) {
		return { score: 0 };
	}
	if (ageMs <= 60_000) {
		return { score: 15, reason: "heartbeat_fresh" };
	}
	if (ageMs <= 5 * 60_000) {
		return { score: 8, reason: "heartbeat_recent" };
	}
	return { score: -10, reason: "heartbeat_stale" };
}

function rankSkill(
	skill: PlatformAgentA2ASkill,
	request: A2ACapabilityMarketRequest,
	taskClass: string | undefined,
): A2ACapabilitySkillRank {
	const reasons = [`skill:${skill.id}`];
	const blockers: string[] = [];
	let score = request.skillId ? 35 : 15;

	if (taskClass && normalizedSet(skill.deniedTaskClasses).has(taskClass)) {
		blockers.push(`task_class_denied:${taskClass}`);
	}
	if (taskClass) {
		const allowedTaskClasses = normalizedSet(skill.allowedTaskClasses);
		if (allowedTaskClasses.size > 0 && !allowedTaskClasses.has(taskClass)) {
			blockers.push(`task_class_not_allowed:${taskClass}`);
		} else if (allowedTaskClasses.has(taskClass)) {
			score += 10;
			reasons.push(`task_class:${taskClass}`);
		}
	}
	if (!hasAll(request.requiredContextGrants, skill.requiredContextGrants)) {
		blockers.push("missing_context_grants");
	}
	if (!hasAll(request.requiredArtifactKinds, skill.requiredArtifactKinds)) {
		blockers.push("missing_required_artifacts");
	}
	if (skill.approvalPolicyRef) {
		score += 4;
		reasons.push("approval_policy");
	}
	if (skill.requiredArtifactKinds?.length) {
		score += 3;
		reasons.push("artifact_contract");
	}

	return {
		selectedSkill: skill,
		score: blockers.length > 0 ? Number.NEGATIVE_INFINITY : score,
		reasons,
		blockers,
	};
}

function noSkillRank(
	request: A2ACapabilityMarketRequest,
	taskClass: string | undefined,
): A2ACapabilitySkillRank {
	const blockers: string[] = [];
	if (request.skillId) {
		blockers.push(`missing_skill:${request.skillId}`);
	}
	if (taskClass) {
		blockers.push(`missing_task_class:${taskClass}`);
	}
	if (hasRequestedValues(request.requiredContextGrants)) {
		blockers.push("missing_context_grants");
	}
	if (hasRequestedValues(request.requiredArtifactKinds)) {
		blockers.push("missing_required_artifacts");
	}
	return { score: 0, reasons: [], blockers };
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function selectSkillRank(
	candidate: PlatformAgentRegistryA2APeerCandidate,
	request: A2ACapabilityMarketRequest,
	taskClass: string | undefined,
): A2ACapabilitySkillRank {
	if (request.skillId) {
		const selectedSkill = candidate.skills.find(
			(skill) => skill.id === request.skillId,
		);
		return selectedSkill
			? rankSkill(selectedSkill, request, taskClass)
			: noSkillRank(request, taskClass);
	}

	if (candidate.skills.length === 0) {
		return noSkillRank(request, taskClass);
	}

	const skillRanks = candidate.skills.map((skill) =>
		rankSkill(skill, request, taskClass),
	);
	const bestSkillRank = skillRanks
		.filter((rank) => rank.blockers.length === 0)
		.reduce<A2ACapabilitySkillRank | undefined>((best, rank) => {
			if (!best || rank.score > best.score) {
				return rank;
			}
			return best;
		}, undefined);

	if (bestSkillRank) {
		return bestSkillRank;
	}

	return {
		score: Number.NEGATIVE_INFINITY,
		reasons: [],
		blockers: unique(skillRanks.flatMap((rank) => rank.blockers)),
	};
}

function rankCandidate(
	candidate: PlatformAgentRegistryA2APeerCandidate,
	request: A2ACapabilityMarketRequest,
): A2ACapabilityMarketRank {
	const now = request.now ?? new Date();
	const taskClass = request.taskClass?.trim();
	const skillRank = selectSkillRank(candidate, request, taskClass);
	const selectedSkill = skillRank.selectedSkill;
	const reasons = [...skillRank.reasons];
	const blockers = [...skillRank.blockers];
	let score = skillRank.score;

	const status = statusScore(candidate.agent.status);
	score += status.score;
	reasons.push(status.reason);

	const heartbeat = heartbeatScore(candidate.agent.lastHeartbeatAt, now);
	score += heartbeat.score;
	if (heartbeat.reason) {
		reasons.push(heartbeat.reason);
	}
	if (candidate.endpointKind === "internal" && request.preferInternalEndpoint) {
		score += 8;
		reasons.push("internal_endpoint");
	}
	if (candidate.pushNotifications) {
		score += 5;
		reasons.push("push_notifications");
	}

	return {
		version: A2A_CAPABILITY_MARKET_VERSION,
		candidate,
		...(selectedSkill ? { selectedSkill } : {}),
		score: blockers.length > 0 ? Number.NEGATIVE_INFINITY : score,
		reasons,
		blockers,
	};
}

export function rankA2ACapabilityPeers(
	candidates: PlatformAgentRegistryA2APeerCandidate[],
	request: A2ACapabilityMarketRequest = {},
): A2ACapabilityMarketRank[] {
	return candidates
		.map((candidate) => rankCandidate(candidate, request))
		.filter((rank) => rank.blockers.length === 0)
		.sort((left, right) => {
			if (right.score !== left.score) {
				return right.score - left.score;
			}
			return (
				left.candidate.agent.id ?? left.candidate.endpointUrl
			).localeCompare(right.candidate.agent.id ?? right.candidate.endpointUrl);
		});
}

export function selectA2ACapabilityPeer(
	candidates: PlatformAgentRegistryA2APeerCandidate[],
	request: A2ACapabilityMarketRequest = {},
): A2ACapabilityMarketRank | undefined {
	return rankA2ACapabilityPeers(candidates, request)[0];
}
