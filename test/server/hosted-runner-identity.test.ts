import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	HOSTED_RUNNER_IDENTITY_PROTOCOL_VERSION,
	buildHostedRunnerIdentity,
} from "../../src/server/handlers/hosted-runner-identity.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "maestro-runner-identity-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
	);
});

describe("hosted runner identity", () => {
	it("returns the Platform attach fence identity when the runtime is ready", async () => {
		const workspaceRoot = await createTempWorkspace();

		await expect(
			buildHostedRunnerIdentity({
				enabled: true,
				runnerSessionId: "mrs_123",
				ownerInstanceId: "pod_123",
				workspaceRoot,
				agentRunId: "agent_run_123",
				a2aMessageId: "maestro-session:ws_123:session_123",
				a2aTaskId: "agent_run_123",
				agentRuntimeWorkerQueue: "agent-runtime.production",
				agentRuntimeCorrelationPath:
					"maestro_message_id=maestro-session:ws_123:session_123 a2a_task_id=agent_run_123 platform_agent_run_id=agent_run_123 worker_queue=agent-runtime.production",
			}),
		).resolves.toMatchObject({
			protocol_version: HOSTED_RUNNER_IDENTITY_PROTOCOL_VERSION,
			runner_session_id: "mrs_123",
			owner_instance_id: "pod_123",
			ready: true,
			draining: false,
			agent_run_id: "agent_run_123",
			a2a_message_id: "maestro-session:ws_123:session_123",
			a2a_task_id: "agent_run_123",
			agent_runtime_worker_queue: "agent-runtime.production",
			agent_runtime_correlation_path:
				"maestro_message_id=maestro-session:ws_123:session_123 a2a_task_id=agent_run_123 platform_agent_run_id=agent_run_123 worker_queue=agent-runtime.production",
			runtime_lease: {
				protocol_version: "evalops.maestro.hosted-runner-lease.v1",
				state: "unbound",
				generation: 0,
				lease_token_present: false,
				updated_at: expect.any(String),
				heartbeat_at: expect.any(String),
			},
		});
	});

	it("reports draining runtimes as not ready", async () => {
		const workspaceRoot = await createTempWorkspace();

		await expect(
			buildHostedRunnerIdentity({
				enabled: true,
				runnerSessionId: "mrs_123",
				ownerInstanceId: "pod_123",
				workspaceRoot,
				draining: true,
				lastDrain: {
					status: "drained",
					manifestPath: "/workspace/.maestro/runner-snapshots/mrs_123.json",
					drainedAt: "2026-04-23T00:00:00.000Z",
				},
			}),
		).resolves.toMatchObject({
			runner_session_id: "mrs_123",
			owner_instance_id: "pod_123",
			ready: false,
			draining: true,
			drain_status: "drained",
			drain_manifest_path: "/workspace/.maestro/runner-snapshots/mrs_123.json",
			drained_at: "2026-04-23T00:00:00.000Z",
		});
	});

	it("projects the last Platform A2A push correlation into identity", async () => {
		const workspaceRoot = await createTempWorkspace();

		await expect(
			buildHostedRunnerIdentity({
				enabled: true,
				runnerSessionId: "mrs_123",
				ownerInstanceId: "pod_123",
				workspaceRoot,
				lastPlatformA2APush: {
					kind: "statusUpdate",
					taskId: "task_123",
					contextId: "ctx_123",
					state: "TASK_STATE_COMPLETED",
					final: true,
					receivedAt: "2026-05-26T12:00:00.000Z",
					runtimeEventId: "event_123",
					runtimeEventType: "RUNTIME_EVENT_TYPE_RUN_SUCCEEDED",
					traceparent:
						"00-11111111111111111111111111111111-2222222222222222-01",
					tracestate: "evalops=push",
					organizationId: "org_123",
					workspaceId: "workspace_123",
					tenantId: "tenant_123",
					agentId: "agent_123",
					actorId: "actor_123",
				},
			}),
		).resolves.toMatchObject({
			last_platform_a2a_push: {
				kind: "statusUpdate",
				task_id: "task_123",
				context_id: "ctx_123",
				state: "TASK_STATE_COMPLETED",
				final: true,
				received_at: "2026-05-26T12:00:00.000Z",
				runtime_event_id: "event_123",
				runtime_event_type: "RUNTIME_EVENT_TYPE_RUN_SUCCEEDED",
				traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
				tracestate: "evalops=push",
				organization_id: "org_123",
				workspace_id: "workspace_123",
				tenant_id: "tenant_123",
				agent_id: "agent_123",
				actor_id: "actor_123",
			},
		});
	});

	it("does not expose identity without the Platform owner generation", async () => {
		const workspaceRoot = await createTempWorkspace();

		await expect(
			buildHostedRunnerIdentity({
				enabled: true,
				runnerSessionId: "mrs_123",
				workspaceRoot,
			}),
		).resolves.toBeNull();
	});

	it("reports missing workspaces as unavailable without changing identity", async () => {
		const workspaceRoot = join(tmpdir(), "maestro-runner-identity-missing");

		await expect(
			buildHostedRunnerIdentity({
				enabled: true,
				runnerSessionId: "mrs_123",
				ownerInstanceId: "pod_123",
				workspaceRoot,
			}),
		).resolves.toMatchObject({
			runner_session_id: "mrs_123",
			owner_instance_id: "pod_123",
			ready: false,
			draining: false,
		});
	});
});
