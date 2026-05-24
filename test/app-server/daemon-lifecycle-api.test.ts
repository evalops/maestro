import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { MaestroAppServerResponseSchema } from "../../packages/contracts/src/maestro-app-server.js";
import {
	createMaestroAppServerDaemonLifecycle,
	createMaestroAppServerSessionApi,
	handleMaestroAppServerRequest,
} from "../../src/app-server/session-api.js";
import type { HostedRunnerContext } from "../../src/server/app-context.js";
import { SessionManager } from "../../src/session/manager.js";

describe("Maestro app-server daemon lifecycle API", () => {
	let testDir: string | undefined;

	afterEach(() => {
		if (testDir && existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
		testDir = undefined;
	});

	function createTestRoot(prefix: string): string {
		testDir = join(tmpdir(), `${prefix}-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		return testDir;
	}

	function createSessionManager(root: string): SessionManager {
		return new SessionManager(false, undefined, {
			sessionDir: join(root, "sessions"),
		});
	}

	function createHostedRunner(root: string): HostedRunnerContext {
		const workspaceRoot = join(root, "workspace");
		mkdirSync(workspaceRoot, { recursive: true });
		writeFileSync(join(workspaceRoot, "README.md"), "# workspace\n", "utf8");
		return {
			enabled: true,
			runnerSessionId: "mrs_daemon_1",
			ownerInstanceId: "pod_daemon_1",
			workspaceRoot,
			snapshotRoot: join(workspaceRoot, ".maestro", "runner-snapshots"),
			workspaceId: "ws_daemon_1",
			agentId: "agent_daemon_1",
			agentRunId: "run_daemon_1",
			agentRuntimeLeaseToken: "super-secret-lease-token",
			activeMaestroSessionId: "session_daemon_1",
		};
	}

	it("advertises daemon status while keeping remote control unavailable without a hosted runner", async () => {
		const root = createTestRoot("maestro-app-server-daemon-unavailable");
		const api = createMaestroAppServerSessionApi(createSessionManager(root));

		expect(api.initialize()).toMatchObject({
			capabilities: {
				daemonStatus: true,
				remoteControlStatus: false,
				remoteControlLease: false,
				remoteControlDrain: false,
			},
		});

		const status = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "daemon-status",
			method: "daemon/status",
		});

		expect(status.result).toMatchObject({
			daemon: {
				pid: process.pid,
				platform: process.platform,
			},
			remoteControl: {
				available: false,
				status: "unavailable",
				lease: null,
			},
		});
		expect(Value.Check(MaestroAppServerResponseSchema, status)).toBe(true);

		const remoteStatus = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "remote-status",
			method: "remoteControl/status",
		});
		expect(remoteStatus.error).toMatchObject({
			code: -32601,
			message: "Remote control lifecycle is not available",
		});
	});

	it("reports remote-control status and heartbeats the hosted-runner lease without leaking tokens", async () => {
		const root = createTestRoot("maestro-app-server-daemon-lease");
		let currentTime = new Date("2026-05-24T05:00:00.000Z");
		const hostedRunner = createHostedRunner(root);
		const api = createMaestroAppServerSessionApi(createSessionManager(root), {
			daemonLifecycle: createMaestroAppServerDaemonLifecycle({
				hostedRunner,
				now: () => currentTime,
			}),
		});

		expect(api.initialize()).toMatchObject({
			capabilities: {
				daemonStatus: true,
				remoteControlStatus: true,
				remoteControlLease: true,
				remoteControlDrain: true,
			},
		});

		const status = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "remote-status",
			method: "remoteControl/status",
		});
		expect(status.result).toMatchObject({
			available: true,
			status: "ready",
			runnerSessionId: "mrs_daemon_1",
			workspaceId: "ws_daemon_1",
			maestroSessionId: "session_daemon_1",
			lease: {
				state: "bound",
				generation: 0,
				heartbeatAt: "2026-05-24T05:00:00.000Z",
				leaseTokenPresent: true,
			},
		});
		expect(JSON.stringify(status.result)).not.toContain("super-secret");
		expect(Value.Check(MaestroAppServerResponseSchema, status)).toBe(true);

		currentTime = new Date("2026-05-24T05:00:30.000Z");
		const heartbeat = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "remote-lease-heartbeat",
			method: "remoteControl/lease/heartbeat",
		});
		expect(heartbeat.result).toMatchObject({
			available: true,
			lease: {
				state: "bound",
				generation: 1,
				heartbeatAt: "2026-05-24T05:00:30.000Z",
				updatedAt: "2026-05-24T05:00:30.000Z",
				leaseTokenPresent: true,
			},
		});
		expect(hostedRunner.runtimeLease?.generation).toBe(1);
		expect(JSON.stringify(heartbeat.result)).not.toContain("super-secret");
		expect(Value.Check(MaestroAppServerResponseSchema, heartbeat)).toBe(true);
	});

	it("drains remote control end to end and writes the hosted-runner manifest", async () => {
		const root = createTestRoot("maestro-app-server-daemon-drain");
		const hostedRunner = createHostedRunner(root);
		const api = createMaestroAppServerSessionApi(createSessionManager(root), {
			daemonLifecycle: createMaestroAppServerDaemonLifecycle({
				hostedRunner,
				now: () => new Date("2026-05-24T05:10:00.000Z"),
			}),
		});

		const drained = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "remote-drain",
			method: "remoteControl/drain",
			params: {
				reason: "local_e2e",
				requestedBy: "app_server_test",
				exportPaths: ["README.md"],
			},
		});

		expect(drained.result).toMatchObject({
			drained: true,
			status: "drained",
			runnerSessionId: "mrs_daemon_1",
			reason: "local_e2e",
			requestedBy: "app_server_test",
			remoteControl: {
				available: true,
				status: "draining",
				lastDrain: {
					status: "drained",
					drainedAt: "2026-05-24T05:10:00.000Z",
					reason: "local_e2e",
					requestedBy: "app_server_test",
				},
			},
			manifest: {
				runner_session_id: "mrs_daemon_1",
				maestro_session_id: "session_daemon_1",
				reason: "local_e2e",
				requested_by: "app_server_test",
				runtime: {
					flush_status: "skipped",
					session_id: "session_daemon_1",
				},
			},
		});
		expect(hostedRunner.draining).toBe(true);
		expect(typeof drained.result?.manifestPath).toBe("string");
		const manifestPath =
			typeof drained.result?.manifestPath === "string"
				? drained.result.manifestPath
				: "";
		expect(existsSync(manifestPath)).toBe(true);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
			workspace_export: { paths: Array<{ relative_path: string }> };
			retention_policy: { redaction: { forbidden_plaintext: string[] } };
		};
		expect(manifest.workspace_export.paths).toEqual([
			expect.objectContaining({ relative_path: "README.md" }),
		]);
		expect(manifest.retention_policy.redaction.forbidden_plaintext).toContain(
			"attach_tokens",
		);
		expect(JSON.stringify(drained.result)).not.toContain("super-secret");
		expect(Value.Check(MaestroAppServerResponseSchema, drained)).toBe(true);
	});

	it("returns invalid params when remote-control drain export paths escape the workspace", async () => {
		const root = createTestRoot("maestro-app-server-daemon-drain-invalid");
		const hostedRunner = createHostedRunner(root);
		const outsidePath = join(root, "outside.txt");
		writeFileSync(outsidePath, "outside workspace\n", "utf8");
		const api = createMaestroAppServerSessionApi(createSessionManager(root), {
			daemonLifecycle: createMaestroAppServerDaemonLifecycle({
				hostedRunner,
				now: () => new Date("2026-05-24T05:20:00.000Z"),
			}),
		});

		const rejected = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "remote-drain-invalid-export",
			method: "remoteControl/drain",
			params: {
				exportPaths: [outsidePath],
			},
		});

		expect(rejected.error).toMatchObject({
			code: -32602,
			message: expect.stringContaining(
				"Export path escapes hosted runner workspace root",
			),
		});
		expect(Value.Check(MaestroAppServerResponseSchema, rejected)).toBe(true);
	});
});
