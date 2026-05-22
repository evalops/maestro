import type { HostedRunnerContext } from "./app-context.js";

export const HOSTED_RUNNER_LEASE_PROTOCOL_VERSION =
	"evalops.maestro.hosted-runner-lease.v1";

export type HostedRunnerLeaseState = "unbound" | "bound" | "draining";
export type HostedRunnerLeaseDecisionReason =
	| "runtime_owned_elsewhere"
	| "runtime_draining";

export interface HostedRunnerLeaseSnapshot {
	protocolVersion: typeof HOSTED_RUNNER_LEASE_PROTOCOL_VERSION;
	runnerSessionId: string;
	ownerInstanceId?: string;
	workspaceId?: string;
	agentId?: string;
	agentRunId?: string;
	leaseToken?: string;
	maestroSessionId?: string;
	configuredMaestroSessionId?: string;
	state: HostedRunnerLeaseState;
	generation: number;
	heartbeatAt: string;
	updatedAt: string;
}

export type HostedRunnerLeaseDecision =
	| {
			ok: true;
			snapshot: HostedRunnerLeaseSnapshot;
	  }
	| {
			ok: false;
			reason: HostedRunnerLeaseDecisionReason;
			message: string;
			snapshot: HostedRunnerLeaseSnapshot;
			activeSessionId?: string;
			requestedSessionId?: string;
	  };

function nowIso(now = new Date()): string {
	return now.toISOString();
}

function currentGeneration(hostedRunner: HostedRunnerContext): number {
	return hostedRunner.runtimeLease?.generation ?? 0;
}

export function hostedRunnerLeaseSnapshot(
	hostedRunner: HostedRunnerContext,
	now = new Date(),
): HostedRunnerLeaseSnapshot {
	const activeSessionId =
		hostedRunner.activeMaestroSessionId ??
		hostedRunner.configuredMaestroSessionId;
	const previous = hostedRunner.runtimeLease;
	return {
		protocolVersion: HOSTED_RUNNER_LEASE_PROTOCOL_VERSION,
		runnerSessionId: hostedRunner.runnerSessionId,
		...(hostedRunner.ownerInstanceId
			? { ownerInstanceId: hostedRunner.ownerInstanceId }
			: {}),
		...(hostedRunner.workspaceId
			? { workspaceId: hostedRunner.workspaceId }
			: {}),
		...(hostedRunner.agentId ? { agentId: hostedRunner.agentId } : {}),
		...(hostedRunner.agentRunId ? { agentRunId: hostedRunner.agentRunId } : {}),
		...(hostedRunner.agentRuntimeLeaseToken
			? { leaseToken: hostedRunner.agentRuntimeLeaseToken }
			: {}),
		...(activeSessionId ? { maestroSessionId: activeSessionId } : {}),
		...(hostedRunner.configuredMaestroSessionId
			? { configuredMaestroSessionId: hostedRunner.configuredMaestroSessionId }
			: {}),
		state: hostedRunner.draining
			? "draining"
			: activeSessionId
				? "bound"
				: "unbound",
		generation: previous?.generation ?? 0,
		heartbeatAt: previous?.heartbeatAt ?? nowIso(now),
		updatedAt: previous?.updatedAt ?? nowIso(now),
	};
}

function persistLeaseSnapshot(
	hostedRunner: HostedRunnerContext,
	snapshot: HostedRunnerLeaseSnapshot,
): HostedRunnerLeaseSnapshot {
	hostedRunner.runtimeLease = snapshot;
	return snapshot;
}

export function refreshHostedRunnerLease(
	hostedRunner: HostedRunnerContext,
	now = new Date(),
): HostedRunnerLeaseSnapshot {
	const snapshot = {
		...hostedRunnerLeaseSnapshot(hostedRunner, now),
		heartbeatAt: nowIso(now),
		updatedAt: nowIso(now),
		generation: currentGeneration(hostedRunner) + 1,
	};
	return persistLeaseSnapshot(hostedRunner, snapshot);
}

export function evaluateHostedRunnerLeaseUse(
	hostedRunner: HostedRunnerContext,
	requestedSessionId: string | undefined,
	now = new Date(),
): HostedRunnerLeaseDecision {
	const snapshot = hostedRunnerLeaseSnapshot(hostedRunner, now);
	if (snapshot.state === "draining") {
		return {
			ok: false,
			reason: "runtime_draining",
			message:
				"Hosted runner is draining and not accepting headless session traffic",
			snapshot,
			activeSessionId: snapshot.maestroSessionId,
			requestedSessionId,
		};
	}
	if (!snapshot.maestroSessionId) {
		return { ok: true, snapshot };
	}
	if (!requestedSessionId) {
		return {
			ok: false,
			reason: "runtime_owned_elsewhere",
			message: `Hosted runner is already bound to Maestro session ${snapshot.maestroSessionId}`,
			snapshot,
			activeSessionId: snapshot.maestroSessionId,
			requestedSessionId,
		};
	}
	if (requestedSessionId !== snapshot.maestroSessionId) {
		return {
			ok: false,
			reason: "runtime_owned_elsewhere",
			message: `Hosted runner is bound to Maestro session ${snapshot.maestroSessionId}`,
			snapshot,
			activeSessionId: snapshot.maestroSessionId,
			requestedSessionId,
		};
	}
	return { ok: true, snapshot };
}

export function claimHostedRunnerLease(
	hostedRunner: HostedRunnerContext,
	sessionId: string,
	now = new Date(),
): HostedRunnerLeaseDecision {
	const decision = evaluateHostedRunnerLeaseUse(hostedRunner, sessionId, now);
	if (!decision.ok) {
		return decision;
	}
	const sameSessionReclaim =
		hostedRunner.runtimeLease?.state === "bound" &&
		hostedRunner.runtimeLease.maestroSessionId === sessionId;
	hostedRunner.activeMaestroSessionId = sessionId;
	const snapshot = {
		...hostedRunnerLeaseSnapshot(hostedRunner, now),
		maestroSessionId: sessionId,
		state: "bound" as const,
		generation: sameSessionReclaim
			? currentGeneration(hostedRunner)
			: currentGeneration(hostedRunner) + 1,
		heartbeatAt: nowIso(now),
		updatedAt: sameSessionReclaim ? decision.snapshot.updatedAt : nowIso(now),
	};
	return { ok: true, snapshot: persistLeaseSnapshot(hostedRunner, snapshot) };
}

export function markHostedRunnerLeaseDraining(
	hostedRunner: HostedRunnerContext,
	now = new Date(),
): HostedRunnerLeaseSnapshot {
	hostedRunner.draining = true;
	const snapshot = {
		...hostedRunnerLeaseSnapshot(hostedRunner, now),
		state: "draining" as const,
		generation: currentGeneration(hostedRunner) + 1,
		updatedAt: nowIso(now),
	};
	return persistLeaseSnapshot(hostedRunner, snapshot);
}

export function bindHostedRunnerPlatformLease(
	hostedRunner: HostedRunnerContext,
	input: {
		agentRunId?: string;
		agentId?: string;
		leaseToken?: string;
	},
	now = new Date(),
): HostedRunnerLeaseSnapshot {
	if (input.agentRunId) {
		hostedRunner.agentRunId = input.agentRunId;
	}
	if (input.agentId) {
		hostedRunner.agentId = input.agentId;
	}
	if (input.leaseToken) {
		hostedRunner.agentRuntimeLeaseToken = input.leaseToken;
	} else {
		delete hostedRunner.agentRuntimeLeaseToken;
	}
	const snapshot = {
		...hostedRunnerLeaseSnapshot(hostedRunner, now),
		generation: currentGeneration(hostedRunner) + 1,
		updatedAt: nowIso(now),
	};
	return persistLeaseSnapshot(hostedRunner, snapshot);
}
