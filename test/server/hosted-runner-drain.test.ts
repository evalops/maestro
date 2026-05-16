import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	HEADLESS_PROTOCOL_VERSION,
	createHeadlessRuntimeState,
} from "../../src/cli/headless-protocol.js";
import type { HostedRunnerContext } from "../../src/server/app-context.js";
import {
	HOSTED_RUNNER_RETENTION_POLICY_VERSION,
	HOSTED_RUNNER_SNAPSHOT_MANIFEST_VERSION,
	HOSTED_RUNNER_WORK_CONTINUITY_VERSION,
	HostedRunnerDrainReasonValue,
	HostedRunnerDrainRequestedByValue,
	HostedRunnerDrainStatusValue,
	HostedRunnerRuntimeFlushStatusValue,
	HostedRunnerWorkspaceExportPathTypeValue,
	drainHostedRunner,
	drainHostedRunnerForShutdown,
} from "../../src/server/handlers/hosted-runner-drain.js";
import type { HeadlessRuntimeSnapshot } from "../../src/server/headless-runtime-service.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "maestro-runner-drain-"));
	const resolved = await realpath(dir);
	tempDirs.push(resolved);
	await writeFile(join(resolved, "README.md"), "# workspace\n", "utf8");
	return resolved;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
	);
});

function hostedRunnerContext(
	workspaceRoot: string,
	snapshotRoot = join(workspaceRoot, ".maestro", "runner-snapshots"),
): HostedRunnerContext {
	return {
		enabled: true,
		runnerSessionId: "mrs_123",
		ownerInstanceId: "pod_123",
		workspaceRoot,
		snapshotRoot,
		workspaceId: "ws_123",
		agentRunId: "ar_123",
		activeMaestroSessionId: "session_123",
	};
}

function runtimeSnapshot(
	workspaceRoot: string,
	cursor = 7,
): HeadlessRuntimeSnapshot {
	const state = createHeadlessRuntimeState();
	state.protocol_version = HEADLESS_PROTOCOL_VERSION;
	state.session_id = "session_123";
	state.cwd = workspaceRoot;
	state.model = "gpt-5.4";
	state.provider = "openai";
	state.last_status = "Ready";
	state.is_ready = true;
	return {
		protocolVersion: HEADLESS_PROTOCOL_VERSION,
		session_id: "session_123",
		cursor,
		last_init: null,
		state,
	};
}

describe("hosted runner drain", () => {
	it("drains the active runtime and writes a bounded snapshot manifest", async () => {
		const workspaceRoot = await createTempWorkspace();
		const context = hostedRunnerContext(workspaceRoot);
		const snapshot = runtimeSnapshot(workspaceRoot);
		const drainRuntime = vi.fn().mockResolvedValue({
			sessionId: "session_123",
			sessionFile: join(workspaceRoot, ".maestro", "sessions", "session.jsonl"),
			protocolVersion: HEADLESS_PROTOCOL_VERSION,
			cursor: 7,
			snapshot,
		});

		const result = await drainHostedRunner(
			{
				reason: "ttl_expired",
				requestedBy: "platform",
				exportPaths: [".", "README.md"],
			},
			{
				hostedRunner: context,
				drainRuntime,
				now: () => new Date("2026-04-23T00:00:00.000Z"),
			},
		);

		expect(result?.status).toBe(HostedRunnerDrainStatusValue.Drained);
		expect(result?.runner_session_id).toBe("mrs_123");
		expect(result?.reason).toBe("ttl_expired");
		expect(result?.requested_by).toBe("platform");
		expect(context.draining).toBe(true);
		expect(context.lastDrain).toMatchObject({
			status: HostedRunnerDrainStatusValue.Drained,
			manifestPath: result?.manifest_path,
			drainedAt: "2026-04-23T00:00:00.000Z",
			reason: "ttl_expired",
			requestedBy: "platform",
		});
		expect(drainRuntime).toHaveBeenCalledWith("session_123", {
			reason: "ttl_expired",
			requestedBy: "platform",
		});
		expect(result?.manifest).toMatchObject({
			protocol_version: HOSTED_RUNNER_SNAPSHOT_MANIFEST_VERSION,
			runner_session_id: "mrs_123",
			workspace_id: "ws_123",
			agent_run_id: "ar_123",
			maestro_session_id: "session_123",
			reason: "ttl_expired",
			requested_by: "platform",
			created_at: "2026-04-23T00:00:00.000Z",
			workspace_root: workspaceRoot,
			runtime: {
				flush_status: HostedRunnerRuntimeFlushStatusValue.Completed,
				session_id: "session_123",
				protocol_version: HEADLESS_PROTOCOL_VERSION,
				cursor: 7,
			},
			work_continuity: {
				protocol_version: HOSTED_RUNNER_WORK_CONTINUITY_VERSION,
				active_tool_count: 0,
				tracked_tool_count: 0,
				pending_request_count: 0,
				codex_subagent_tool_call_ids: [],
				codex_subagent_child_run_ids: [],
				codex_subagent_thread_ids: [],
			},
			retention_policy: {
				policy_version: HOSTED_RUNNER_RETENTION_POLICY_VERSION,
				managed_by: "platform",
				visibility: {
					control_plane_metadata: "operator",
					workspace_export: "tenant",
					runtime_snapshot: "internal",
					runtime_logs: "operator",
				},
				redaction: {
					required_before_external_persistence: [
						"runtime_snapshot",
						"runtime_logs",
					],
					forbidden_plaintext: [
						"provider_credentials",
						"tool_secrets",
						"attach_tokens",
						"artifact_access_tokens",
						"raw_environment",
					],
				},
			},
			snapshot,
		});
		expect(result?.manifest).not.toHaveProperty("manifest_version");
		expect(result?.manifest).not.toHaveProperty("status");
		expect(result?.manifest).not.toHaveProperty("snapshot_root");
		expect(result?.manifest).not.toHaveProperty("snapshot_path");
		expect(result?.manifest).not.toHaveProperty("stop_reason");
		expect(result?.manifest.workspace_export.paths).toEqual([
			{
				input: ".",
				path: workspaceRoot,
				relative_path: ".",
				type: HostedRunnerWorkspaceExportPathTypeValue.Directory,
			},
			{
				input: "README.md",
				path: join(workspaceRoot, "README.md"),
				relative_path: "README.md",
				type: HostedRunnerWorkspaceExportPathTypeValue.File,
			},
		]);

		const persisted = JSON.parse(
			await readFile(result!.manifest_path, "utf8"),
		) as unknown;
		expect(persisted).toEqual(result?.manifest);
	});

	it("counts pending requests from source arrays when the derived list is stale", async () => {
		const workspaceRoot = await createTempWorkspace();
		const context = hostedRunnerContext(workspaceRoot);
		const snapshot = runtimeSnapshot(workspaceRoot);
		snapshot.state.pending_approvals = [
			{
				call_id: "call_pending",
				tool: "bash",
				args: { command: "ls" },
			},
		];
		snapshot.state.pending_requests = [];
		const drainRuntime = vi.fn().mockResolvedValue({
			sessionId: "session_123",
			sessionFile: join(workspaceRoot, ".maestro", "sessions", "session.jsonl"),
			protocolVersion: HEADLESS_PROTOCOL_VERSION,
			cursor: 7,
			snapshot,
		});

		const result = await drainHostedRunner(
			{ reason: "ttl_expired" },
			{
				hostedRunner: context,
				drainRuntime,
				now: () => new Date("2026-04-23T00:00:30.000Z"),
			},
		);

		expect(result?.manifest.work_continuity.pending_request_count).toBe(1);
	});

	it("records an interrupted manifest when runtime drain fails", async () => {
		const workspaceRoot = await createTempWorkspace();
		const context = hostedRunnerContext(workspaceRoot);
		const drainRuntime = vi
			.fn()
			.mockRejectedValue(new Error("flush timed out"));

		const result = await drainHostedRunner(
			{ reason: "preempted" },
			{
				hostedRunner: context,
				drainRuntime,
				now: () => new Date("2026-04-23T00:01:00.000Z"),
			},
		);

		expect(result?.status).toBe(HostedRunnerDrainStatusValue.Interrupted);
		expect(context.draining).toBe(true);
		expect(result?.manifest.protocol_version).toBe(
			HOSTED_RUNNER_SNAPSHOT_MANIFEST_VERSION,
		);
		expect(result?.manifest.maestro_session_id).toBe("session_123");
		expect(result?.manifest.runtime).toMatchObject({
			flush_status: HostedRunnerRuntimeFlushStatusValue.Failed,
			session_id: "session_123",
			error: "flush timed out",
		});
		expect(result?.manifest.snapshot).toMatchObject({
			protocolVersion: HEADLESS_PROTOCOL_VERSION,
			session_id: "session_123",
			cursor: 0,
			state: {
				is_ready: false,
				last_status: "Drain interrupted before runtime flush completed",
				last_error: "flush timed out",
				last_error_type: "protocol",
			},
		});
		const persisted = JSON.parse(
			await readFile(result!.manifest_path, "utf8"),
		) as Record<string, unknown>;
		expect(persisted).not.toHaveProperty("status");
		expect(persisted).toEqual(result?.manifest);
	});

	it("records Codex subagent continuity without copying prompt payloads into manifest metadata", async () => {
		const workspaceRoot = await createTempWorkspace();
		const context = hostedRunnerContext(workspaceRoot);
		const snapshot = runtimeSnapshot(workspaceRoot);
		snapshot.state.active_tools = [
			{
				call_id: "collab-spawn-1",
				tool: "codex.subagent.spawnAgent",
				output: "starting child",
			},
		];
		snapshot.state.tracked_tools = [
			{
				call_id: "collab-spawn-1",
				tool: "codex.subagent.spawnAgent",
				args: {
					prompt: "Sensitive child task prompt must stay in snapshot only",
					codex_work_graph: {
						schema_version: "evalops.maestro.codex.subagent-workgraph.v1",
						tool_call_id: "collab-spawn-1",
						tool: "spawnAgent",
						status: "inProgress",
						child_runs: [
							{
								thread_id: "child-thread-1",
								child_run_id: "agent-run-child-1",
								operation: "spawnAgent",
							},
						],
					},
				},
			},
		];

		const result = await drainHostedRunner(
			{ reason: "ttl_expired" },
			{
				hostedRunner: context,
				drainRuntime: vi.fn().mockResolvedValue({
					sessionId: "session_123",
					snapshot,
				}),
				now: () => new Date("2026-04-23T00:03:00.000Z"),
			},
		);

		expect(result?.manifest.work_continuity).toEqual({
			protocol_version: HOSTED_RUNNER_WORK_CONTINUITY_VERSION,
			active_tool_count: 1,
			tracked_tool_count: 1,
			pending_request_count: 0,
			codex_subagent_tool_call_ids: ["collab-spawn-1"],
			codex_subagent_child_run_ids: ["agent-run-child-1"],
			codex_subagent_thread_ids: ["child-thread-1"],
		});
		const manifestWithoutSnapshot = {
			...result!.manifest,
			snapshot: undefined,
		};
		expect(JSON.stringify(manifestWithoutSnapshot)).not.toContain(
			"Sensitive child task prompt",
		);
	});

	it("records snake_case Codex graph child run continuity fields", async () => {
		const workspaceRoot = await createTempWorkspace();
		const context = hostedRunnerContext(workspaceRoot);
		const snapshot = runtimeSnapshot(workspaceRoot);
		snapshot.state.active_tools = [
			{
				call_id: "collab-spawn-2",
				tool: "codex.subagent.spawnAgent",
				output: "starting child",
			},
		];
		snapshot.state.tracked_tools = [
			{
				call_id: "collab-spawn-2",
				tool: "codex.subagent.spawnAgent",
				args: {
					prompt: "Sensitive child task prompt must stay in snapshot only",
					codex_work_graph: {
						schema_version: "evalops.maestro.codex.subagent-workgraph.v1",
						toolCallId: "collab-spawn-2",
						tool: "spawnAgent",
						status: "inProgress",
						child_runs: [
							{
								thread_id: "child-thread-2",
								child_run_id: "agent-run-child-2",
								operation: "spawnAgent",
							},
						],
					},
				},
			},
		];

		const result = await drainHostedRunner(
			{ reason: "ttl_expired" },
			{
				hostedRunner: context,
				drainRuntime: vi.fn().mockResolvedValue({
					sessionId: "session_123",
					snapshot,
				}),
				now: () => new Date("2026-04-23T00:04:00.000Z"),
			},
		);

		expect(result?.manifest.work_continuity).toEqual({
			protocol_version: HOSTED_RUNNER_WORK_CONTINUITY_VERSION,
			active_tool_count: 1,
			tracked_tool_count: 1,
			pending_request_count: 0,
			codex_subagent_tool_call_ids: ["collab-spawn-2"],
			codex_subagent_child_run_ids: ["agent-run-child-2"],
			codex_subagent_thread_ids: ["child-thread-2"],
		});
	});

	it("records a skipped manifest when no runtime state is available", async () => {
		const workspaceRoot = await createTempWorkspace();
		const context = hostedRunnerContext(workspaceRoot);
		const drainRuntime = vi.fn().mockResolvedValue(null);

		const result = await drainHostedRunner(
			{ reason: "empty-runtime" },
			{
				hostedRunner: context,
				drainRuntime,
				now: () => new Date("2026-04-23T00:02:00.000Z"),
			},
		);

		expect(result?.status).toBe(HostedRunnerDrainStatusValue.Drained);
		expect(result?.manifest).toMatchObject({
			protocol_version: HOSTED_RUNNER_SNAPSHOT_MANIFEST_VERSION,
			maestro_session_id: "session_123",
			reason: "empty-runtime",
			runtime: {
				flush_status: HostedRunnerRuntimeFlushStatusValue.Skipped,
				session_id: "session_123",
			},
			snapshot: {
				protocolVersion: HEADLESS_PROTOCOL_VERSION,
				session_id: "session_123",
				cursor: 0,
				state: {
					is_ready: false,
					last_status: "Drain skipped: no runtime activity was available",
				},
			},
			retention_policy: {
				policy_version: HOSTED_RUNNER_RETENTION_POLICY_VERSION,
				managed_by: "platform",
			},
		});
	});

	it("drains active runtime state for process shutdown", async () => {
		const workspaceRoot = await createTempWorkspace();
		const context = hostedRunnerContext(workspaceRoot);
		const snapshot = runtimeSnapshot(workspaceRoot, 11);
		const runtime = {
			getSnapshot: vi.fn(() => snapshot),
			getSessionFile: vi.fn(() =>
				join(workspaceRoot, ".maestro", "sessions", "session.jsonl"),
			),
			dispose: vi.fn().mockResolvedValue(undefined),
			completeHostedAgentRuntimeRun: vi.fn().mockResolvedValue(undefined),
			failHostedAgentRuntimeRun: vi.fn().mockResolvedValue(undefined),
		};
		const headlessRuntimeService = {
			getRuntimeBySessionId: vi.fn(() => runtime),
		};

		const result = await drainHostedRunnerForShutdown(
			{
				hostedRunner: context,
				headlessRuntimeService,
			},
			{
				now: () => new Date("2026-04-23T00:02:30.000Z"),
			},
		);

		expect(result?.status).toBe(HostedRunnerDrainStatusValue.Drained);
		expect(result?.reason).toBe(HostedRunnerDrainReasonValue.ProcessShutdown);
		expect(result?.requested_by).toBe(
			HostedRunnerDrainRequestedByValue.MaestroWebServer,
		);
		expect(context.draining).toBe(true);
		expect(headlessRuntimeService.getRuntimeBySessionId).toHaveBeenCalledWith(
			"session_123",
		);
		expect(runtime.dispose).toHaveBeenCalled();
		expect(runtime.completeHostedAgentRuntimeRun).toHaveBeenCalledWith({
			reason: HostedRunnerDrainReasonValue.ProcessShutdown,
			requestedBy: HostedRunnerDrainRequestedByValue.MaestroWebServer,
			flushStatus: HostedRunnerRuntimeFlushStatusValue.Completed,
		});
		expect(runtime.failHostedAgentRuntimeRun).not.toHaveBeenCalled();
		expect(result?.manifest).toMatchObject({
			maestro_session_id: "session_123",
			reason: HostedRunnerDrainReasonValue.ProcessShutdown,
			requested_by: HostedRunnerDrainRequestedByValue.MaestroWebServer,
			runtime: {
				flush_status: HostedRunnerRuntimeFlushStatusValue.Completed,
				session_id: "session_123",
				cursor: 11,
			},
			snapshot,
		});
	});

	it("fails the Platform AgentRuntime run when active runtime drain is interrupted", async () => {
		const workspaceRoot = await createTempWorkspace();
		const context = hostedRunnerContext(workspaceRoot);
		const snapshot = runtimeSnapshot(workspaceRoot, 12);
		snapshot.state.active_tools = [
			{
				call_id: "collab-spawn-interrupted",
				tool: "codex.subagent.spawnAgent",
				output: "still starting child",
			},
		];
		snapshot.state.tracked_tools = [
			{
				call_id: "collab-spawn-interrupted",
				tool: "codex.subagent.spawnAgent",
				args: {
					prompt: "Sensitive interrupted child task prompt",
					codex_work_graph: {
						schema_version: "evalops.maestro.codex.subagent-workgraph.v1",
						child_runs: [
							{
								thread_id: "child-thread-interrupted",
								child_run_id: "agent-run-child-interrupted",
							},
						],
					},
				},
			},
		];
		const runtime = {
			getSnapshot: vi.fn(() => snapshot),
			getSessionFile: vi.fn(() =>
				join(workspaceRoot, ".maestro", "sessions", "session.jsonl"),
			),
			dispose: vi.fn().mockRejectedValue(new Error("flush timed out")),
			completeHostedAgentRuntimeRun: vi.fn().mockResolvedValue(undefined),
			failHostedAgentRuntimeRun: vi.fn().mockResolvedValue(undefined),
		};
		const headlessRuntimeService = {
			getRuntimeBySessionId: vi.fn(() => runtime),
		};

		const result = await drainHostedRunnerForShutdown(
			{
				hostedRunner: context,
				headlessRuntimeService,
			},
			{
				reason: HostedRunnerDrainReasonValue.KubernetesPreStop,
				requestedBy: HostedRunnerDrainRequestedByValue.KubernetesPreStop,
				now: () => new Date("2026-04-23T00:02:45.000Z"),
			},
		);

		expect(result?.status).toBe(HostedRunnerDrainStatusValue.Interrupted);
		expect(runtime.completeHostedAgentRuntimeRun).not.toHaveBeenCalled();
		expect(runtime.failHostedAgentRuntimeRun).toHaveBeenCalledWith({
			errorMessage: "Hosted runner drain failed: flush timed out",
			reason: HostedRunnerDrainReasonValue.KubernetesPreStop,
			requestedBy: HostedRunnerDrainRequestedByValue.KubernetesPreStop,
			retryable: false,
		});
		expect(result?.manifest.runtime).toMatchObject({
			flush_status: HostedRunnerRuntimeFlushStatusValue.Failed,
			error: "flush timed out",
			cursor: 12,
		});
		expect(result?.manifest.snapshot).toEqual(snapshot);
		expect(result?.manifest.work_continuity).toEqual({
			protocol_version: HOSTED_RUNNER_WORK_CONTINUITY_VERSION,
			active_tool_count: 1,
			tracked_tool_count: 1,
			pending_request_count: 0,
			codex_subagent_tool_call_ids: ["collab-spawn-interrupted"],
			codex_subagent_child_run_ids: ["agent-run-child-interrupted"],
			codex_subagent_thread_ids: ["child-thread-interrupted"],
		});
	});

	it("rejects export paths outside the hosted workspace root", async () => {
		const workspaceRoot = await createTempWorkspace();
		const outsideRoot = await mkdtemp(
			join(tmpdir(), "maestro-outside-export-"),
		);
		tempDirs.push(outsideRoot);
		await mkdir(join(outsideRoot, "subdir"));
		const context = hostedRunnerContext(workspaceRoot);

		await expect(
			drainHostedRunner(
				{ exportPaths: [join(outsideRoot, "subdir")] },
				{
					hostedRunner: context,
					drainRuntime: vi.fn(),
					now: () => new Date("2026-04-23T00:02:00.000Z"),
				},
			),
		).rejects.toMatchObject({
			statusCode: 400,
			message: expect.stringContaining("escapes hosted runner workspace root"),
		});
	});

	it("leaves local/offline servers unchanged when hosted mode is unavailable", async () => {
		const drainRuntime = vi.fn();

		const result = await drainHostedRunner(
			{ reason: "local" },
			{
				drainRuntime,
				now: () => new Date("2026-04-23T00:03:00.000Z"),
			},
		);

		expect(result).toBeNull();
		expect(drainRuntime).not.toHaveBeenCalled();
	});
});
