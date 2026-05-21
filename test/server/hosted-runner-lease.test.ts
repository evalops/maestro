import { describe, expect, it } from "vitest";
import type { HostedRunnerContext } from "../../src/server/app-context.js";
import {
	HOSTED_RUNNER_LEASE_PROTOCOL_VERSION,
	bindHostedRunnerPlatformLease,
	claimHostedRunnerLease,
	evaluateHostedRunnerLeaseUse,
	markHostedRunnerLeaseDraining,
} from "../../src/server/hosted-runner-lease.js";

function hostedRunner(
	overrides: Partial<HostedRunnerContext> = {},
): HostedRunnerContext {
	return {
		enabled: true,
		runnerSessionId: "runner-session-1",
		ownerInstanceId: "owner-instance-1",
		workspaceRoot: "/tmp/workspace",
		...overrides,
	};
}

describe("hosted runner lease", () => {
	it("claims an unbound runner for the first Maestro session", () => {
		const runner = hostedRunner();
		const result = claimHostedRunnerLease(
			runner,
			"maestro-session-1",
			new Date("2026-05-20T04:00:00.000Z"),
		);

		expect(result.ok).toBe(true);
		expect(runner.activeMaestroSessionId).toBe("maestro-session-1");
		expect(runner.runtimeLease).toMatchObject({
			protocolVersion: HOSTED_RUNNER_LEASE_PROTOCOL_VERSION,
			state: "bound",
			maestroSessionId: "maestro-session-1",
			generation: 1,
		});
	});

	it("rejects a new session when the runner is already bound", () => {
		const runner = hostedRunner({
			activeMaestroSessionId: "maestro-session-1",
		});
		const result = evaluateHostedRunnerLeaseUse(
			runner,
			"maestro-session-2",
			new Date("2026-05-20T04:00:00.000Z"),
		);

		expect(result).toMatchObject({
			ok: false,
			reason: "runtime_owned_elsewhere",
			activeSessionId: "maestro-session-1",
			requestedSessionId: "maestro-session-2",
		});
	});

	it("allows the already-bound session to reattach", () => {
		const runner = hostedRunner({
			activeMaestroSessionId: "maestro-session-1",
		});
		const result = evaluateHostedRunnerLeaseUse(
			runner,
			"maestro-session-1",
			new Date("2026-05-20T04:00:00.000Z"),
		);

		expect(result.ok).toBe(true);
	});

	it("does not advance generation for same-session lease reclaims", () => {
		const runner = hostedRunner();
		claimHostedRunnerLease(
			runner,
			"maestro-session-1",
			new Date("2026-05-20T04:00:00.000Z"),
		);
		const result = claimHostedRunnerLease(
			runner,
			"maestro-session-1",
			new Date("2026-05-20T04:00:05.000Z"),
		);

		expect(result.ok).toBe(true);
		expect(runner.runtimeLease).toMatchObject({
			state: "bound",
			maestroSessionId: "maestro-session-1",
			generation: 1,
			heartbeatAt: "2026-05-20T04:00:05.000Z",
			updatedAt: "2026-05-20T04:00:00.000Z",
		});
	});

	it("marks drain as a stable not-ready lease state", () => {
		const runner = hostedRunner({
			activeMaestroSessionId: "maestro-session-1",
		});
		markHostedRunnerLeaseDraining(runner, new Date("2026-05-20T04:00:00.000Z"));
		const result = evaluateHostedRunnerLeaseUse(
			runner,
			"maestro-session-1",
			new Date("2026-05-20T04:00:01.000Z"),
		);

		expect(runner.runtimeLease).toMatchObject({
			state: "draining",
			generation: 1,
		});
		expect(result).toMatchObject({
			ok: false,
			reason: "runtime_draining",
			activeSessionId: "maestro-session-1",
		});
	});

	it("binds Platform AgentRuntime handles without losing the session lease", () => {
		const runner = hostedRunner({
			activeMaestroSessionId: "maestro-session-1",
		});
		claimHostedRunnerLease(
			runner,
			"maestro-session-1",
			new Date("2026-05-20T04:00:00.000Z"),
		);
		const snapshot = bindHostedRunnerPlatformLease(
			runner,
			{
				agentRunId: "agent-run-1",
				agentId: "agent-1",
				leaseToken: "lease-token-1",
			},
			new Date("2026-05-20T04:00:01.000Z"),
		);

		expect(snapshot).toMatchObject({
			state: "bound",
			maestroSessionId: "maestro-session-1",
			agentRunId: "agent-run-1",
			agentId: "agent-1",
			leaseToken: "lease-token-1",
			generation: 2,
		});
	});

	it("clears stale Platform lease tokens when a later bind omits one", () => {
		const runner = hostedRunner({
			activeMaestroSessionId: "maestro-session-1",
			agentRuntimeLeaseToken: "stale-lease-token",
		});
		claimHostedRunnerLease(
			runner,
			"maestro-session-1",
			new Date("2026-05-20T04:00:00.000Z"),
		);
		const snapshot = bindHostedRunnerPlatformLease(
			runner,
			{
				agentRunId: "agent-run-2",
				agentId: "agent-2",
			},
			new Date("2026-05-20T04:00:01.000Z"),
		);

		expect(runner.agentRuntimeLeaseToken).toBeUndefined();
		expect(snapshot.leaseToken).toBeUndefined();
		expect(snapshot).toMatchObject({
			agentRunId: "agent-run-2",
			agentId: "agent-2",
			generation: 2,
		});
	});
});
