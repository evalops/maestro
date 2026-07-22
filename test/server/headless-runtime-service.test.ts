import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
	AgentEvent,
	AppMessage,
	ThinkingLevel,
} from "../../src/agent/types.js";
import {
	HEADLESS_PROTOCOL_VERSION,
	createHeadlessRuntimeState,
	syncHeadlessPendingRequests,
} from "../../src/cli/headless-protocol.js";
import type { RegisteredModel } from "../../src/models/registry.js";
import { drainHostedRunner } from "../../src/server/handlers/hosted-runner-drain.js";
import {
	HeadlessRuntimeService,
	getFleetPlatformEventBusStatus,
	inferFleetModelTier,
	loadHostedRunnerRestoreManifest,
} from "../../src/server/headless-runtime-service.js";
import type { NativeHeadlessClient } from "../../src/server/native-headless-client.js";
import { SessionManager } from "../../src/session/manager.js";

const TEST_MODEL: RegisteredModel = {
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1/responses",
	reasoning: true,
	toolUse: true,
	input: ["text"],
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	},
	contextWindow: 200_000,
	maxTokens: 32_000,
	providerName: "OpenAI",
	source: "builtin",
	isLocal: false,
};

class FakeAgent {
	state = {
		model: TEST_MODEL,
		systemPrompt: "",
		thinkingLevel: "off" as ThinkingLevel,
		tools: [],
		messages: [] as AppMessage[],
	};

	subscribe(_listener: (event: AgentEvent) => void) {
		return () => {};
	}

	abort() {}
}

function createMockNativeClient(sessionId = "native-sess") {
	const client = new EventEmitter() as EventEmitter & {
		start: ReturnType<typeof vi.fn>;
		stop: ReturnType<typeof vi.fn>;
		hello: ReturnType<typeof vi.fn>;
		init: ReturnType<typeof vi.fn>;
		prompt: ReturnType<typeof vi.fn>;
		interrupt: ReturnType<typeof vi.fn>;
		cancel: ReturnType<typeof vi.fn>;
		send: ReturnType<typeof vi.fn>;
		isRunning: boolean;
	};
	client.isRunning = false;
	client.stop = vi.fn();
	client.hello = vi.fn();
	client.init = vi.fn();
	client.prompt = vi.fn();
	client.interrupt = vi.fn();
	client.cancel = vi.fn();
	client.send = vi.fn();
	client.start = vi.fn(async () => {
		client.isRunning = true;
		return {
			type: "ready",
			protocol_version: HEADLESS_PROTOCOL_VERSION,
			model: TEST_MODEL.id,
			provider: TEST_MODEL.provider,
			session_id: sessionId,
		};
	});
	return client;
}

const tempDirs: string[] = [];
type RestoreManifestFlushStatus =
	| "completed"
	| "failed"
	| "interrupted"
	| "skipped";

function buildRestoreManifest(input: {
	sessionId: string;
	sessionFile: string;
	workspaceRoot: string;
	cursor?: number;
	flushStatus?: RestoreManifestFlushStatus;
	runtimeError?: string;
}) {
	const restoredState = createHeadlessRuntimeState();
	restoredState.protocol_version = HEADLESS_PROTOCOL_VERSION;
	restoredState.session_id = input.sessionId;
	restoredState.cwd = input.workspaceRoot;
	restoredState.connection_count = 2;
	restoredState.subscriber_count = 1;
	restoredState.controller_connection_id = "controller_restored";
	restoredState.controller_subscription_id = "subscription_restored";
	restoredState.client_protocol_version = "2026-04-02";
	restoredState.client_info = { name: "stale-controller" };
	restoredState.capabilities = {
		server_requests: ["approval"],
		utility_operations: ["command_exec"],
		raw_agent_events: true,
	};
	restoredState.opt_out_notifications = ["heartbeat"];
	restoredState.connection_role = "controller";
	restoredState.connections = [
		{
			connection_id: "controller_restored",
			role: "controller",
			client_protocol_version: "2026-04-02",
			client_info: { name: "stale-controller" },
			capabilities: {
				server_requests: ["approval"],
				utility_operations: ["command_exec"],
				raw_agent_events: true,
			},
			opt_out_notifications: ["heartbeat"],
			subscription_count: 1,
			attached_subscription_count: 1,
			controller_lease_granted: true,
		},
		{
			connection_id: "viewer_restored",
			role: "viewer",
			subscription_count: 1,
			attached_subscription_count: 1,
			controller_lease_granted: false,
		},
	];
	restoredState.current_response = {
		response_id: "response_restored",
		text: "partial response",
		thinking: "partial thought",
	};
	restoredState.active_tools = [
		{
			call_id: "call_active_tool",
			tool: "shell",
			output: "still running",
		},
	];
	restoredState.active_utility_commands = [
		{
			command_id: "utility_command_restored",
			command: "npm test",
			cwd: input.workspaceRoot,
			columns: 80,
			output: "stale output",
			owner_connection_id: "controller_restored",
			pid: 1234,
			rows: 24,
			shell_mode: "shell",
			terminal_mode: "pipe",
		},
	];
	restoredState.active_file_watches = [
		{
			watch_id: "file_watch_restored",
			root_dir: input.workspaceRoot,
			include_patterns: ["src/**"],
			exclude_patterns: [],
			debounce_ms: 50,
			owner_connection_id: "controller_restored",
		},
	];
	restoredState.tracked_tools = [
		{
			call_id: "call_tracked_tool",
			tool: "read_file",
			args: { path: "README.md" },
		},
	];
	restoredState.codex_subagent_edges = [
		{
			spawn_tool_call_id: "call_subagent_spawn",
			child_run_id: "agent-run-restored",
			thread_id: "thread-restored",
			operation: "spawn_agent",
			status: "running",
		},
	];
	restoredState.pending_client_tools = [
		{
			call_id: "call_client_tool",
			tool: "artifacts",
			args: { command: "create", filename: "report.txt" },
		},
	];
	restoredState.pending_mcp_elicitations = [
		{
			call_id: "call_mcp_elicitation",
			tool: "mcp.elicit",
			args: { message: "Choose a workspace" },
		},
	];
	restoredState.pending_user_inputs = [
		{
			call_id: "call_user_input",
			tool: "ask_user",
			args: { question: "Continue?" },
		},
	];
	syncHeadlessPendingRequests(restoredState);
	const cursor = input.cursor ?? 7;
	return {
		protocol_version: "evalops.remote-runner.snapshot-manifest.v1",
		maestro_session_id: input.sessionId,
		runtime: {
			flush_status: input.flushStatus ?? "completed",
			...(input.runtimeError ? { error: input.runtimeError } : {}),
			session_id: input.sessionId,
			session_file: input.sessionFile,
			cursor,
		},
		snapshot: {
			protocolVersion: HEADLESS_PROTOCOL_VERSION,
			session_id: input.sessionId,
			cursor,
			last_init: null,
			state: restoredState,
		},
	};
}

describe("inferFleetModelTier", () => {
	it("classifies mini variants as fast before GPT-5 frontier matching", () => {
		expect(inferFleetModelTier("openai", "gpt-5.4-mini")).toBe("fast");
		expect(inferFleetModelTier("openai", "gpt-5.1-codex-mini")).toBe("fast");
	});

	it("classifies non-mini frontier models as frontier", () => {
		expect(inferFleetModelTier("openai", "gpt-5.4")).toBe("frontier");
		expect(inferFleetModelTier("anthropic", "claude-opus-4-1")).toBe(
			"frontier",
		);
	});

	it("does not classify gemini model names as mini variants", () => {
		expect(inferFleetModelTier("google", "gemini-2.5-pro")).toBeUndefined();
		expect(
			inferFleetModelTier("google", "gemini-3-pro-preview"),
		).toBeUndefined();
	});
});

describe("getFleetPlatformEventBusStatus", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("recognizes NATS_URL like the Rust event bus config", () => {
		vi.stubEnv("NATS_URL", "nats://bus.example:4222");
		vi.stubEnv("MAESTRO_EVENT_BUS_URL", "");
		vi.stubEnv("EVALOPS_NATS_URL", "");

		expect(getFleetPlatformEventBusStatus()).toEqual({
			enabled: true,
			reason: "nats",
			subject: "maestro.ambient_agent.routing.selected",
		});
	});
});

describe("HeadlessRuntimeService restore manifests", () => {
	afterEach(async () => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		await Promise.all(
			tempDirs
				.splice(0)
				.map((dir) => rm(dir, { force: true, recursive: true })),
		);
	});

	it("restores runtime state and replay marker from a hosted runner drain manifest", async () => {
		const workspaceRoot = await mkdtemp(
			join(tmpdir(), "maestro-headless-restore-"),
		);
		const sessionDir = await mkdtemp(join(tmpdir(), "maestro-sessions-"));
		tempDirs.push(workspaceRoot, sessionDir);
		const fakeAgent = new FakeAgent();
		const sessionManager = new SessionManager(false, undefined, { sessionDir });
		sessionManager.startSession(fakeAgent.state);
		const sessionId = sessionManager.getSessionId();
		const manifestPath = join(workspaceRoot, "restore-manifest.json");
		await writeFile(
			manifestPath,
			JSON.stringify({
				...buildRestoreManifest({
					sessionId,
					sessionFile: sessionManager.getSessionFile(),
					workspaceRoot,
				}),
			}),
			"utf8",
		);

		const service = new HeadlessRuntimeService();
		const mockClient = createMockNativeClient(sessionId);
		const runtime = await service.ensureRuntime({
			scope_key: "anon",
			registeredModel: TEST_MODEL,
			thinkingLevel: "off",
			approvalMode: "prompt",
			createNativeClient: () => mockClient as unknown as NativeHeadlessClient,
			context: {
				hostedRunner: {
					enabled: true,
					runnerSessionId: "mrs_restore",
					workspaceRoot,
					restoreManifestPath: manifestPath,
				},
			},
			sessionManager,
		});

		expect(mockClient.start).toHaveBeenCalledOnce();
		expect(runtime.getSnapshot()).toMatchObject({
			session_id: sessionId,
			cursor: 7,
			state: {
				is_ready: true,
				last_status: "Restored from snapshot",
				connection_count: 0,
				connections: [],
				controller_connection_id: null,
				controller_subscription_id: null,
				client_protocol_version: undefined,
				client_info: undefined,
				capabilities: undefined,
				opt_out_notifications: undefined,
				connection_role: undefined,
				current_response: undefined,
				subscriber_count: 0,
				active_tools: [],
				active_file_watches: [],
				active_utility_commands: [],
				pending_approvals: [],
				pending_client_tools: [],
				pending_mcp_elicitations: [],
				pending_requests: [],
				pending_user_inputs: [],
				pending_tool_retries: [],
				tracked_tools: [],
				codex_subagent_edges: [],
			},
		});
		expect(runtime.getFleetAgentInstance().activeTasks).toMatchObject({
			activeTools: 0,
			fileWatches: 0,
			total: 0,
			utilityCommands: 0,
		});
		expect(runtime.getFleetAgentInstance()).toMatchObject({
			activeTasks: { total: 0 },
			resourceUtilization: {
				activeTasks: 0,
				connections: 0,
				subscribers: 0,
			},
		});
		expect(runtime.replayFrom(0)).toEqual([
			expect.objectContaining({
				type: "reset",
				reason: "restored_from_snapshot",
				snapshot: expect.objectContaining({
					session_id: sessionId,
					cursor: 7,
					state: expect.objectContaining({
						connection_count: 0,
						connections: [],
						controller_connection_id: null,
						controller_subscription_id: null,
						client_protocol_version: undefined,
						client_info: undefined,
						capabilities: undefined,
						opt_out_notifications: undefined,
						connection_role: undefined,
						current_response: undefined,
						subscriber_count: 0,
						active_tools: [],
						active_file_watches: [],
						active_utility_commands: [],
						tracked_tools: [],
						codex_subagent_edges: [],
					}),
				}),
			}),
		]);

		(
			runtime as unknown as {
				publishSnapshot(): void;
			}
		).publishSnapshot();
		expect(runtime.replayFrom(0)).toEqual([
			expect.objectContaining({
				type: "reset",
				reason: "restored_from_snapshot",
				snapshot: expect.objectContaining({
					session_id: sessionId,
					cursor: 7,
				}),
			}),
			expect.objectContaining({
				type: "snapshot",
				snapshot: expect.objectContaining({
					session_id: sessionId,
					cursor: 8,
					state: expect.objectContaining({
						connection_count: 0,
						connections: [],
						controller_connection_id: null,
						controller_subscription_id: null,
						client_protocol_version: undefined,
						client_info: undefined,
						capabilities: undefined,
						opt_out_notifications: undefined,
						connection_role: undefined,
						current_response: undefined,
						subscriber_count: 0,
						active_tools: [],
						active_file_watches: [],
						active_utility_commands: [],
						tracked_tools: [],
						codex_subagent_edges: [],
					}),
				}),
			}),
		]);
		const subscription = runtime.createSubscription({
			announceConnectionInfo: false,
			role: "controller",
		});
		expect(subscription.opt_out_notifications).toBeUndefined();
		expect(subscription.snapshot.state).toMatchObject({
			client_protocol_version: undefined,
			client_info: undefined,
			capabilities: undefined,
			opt_out_notifications: undefined,
			connection_count: 1,
			connections: [
				expect.objectContaining({
					client_protocol_version: undefined,
					client_info: undefined,
					capabilities: undefined,
					opt_out_notifications: undefined,
				}),
			],
		});
		await runtime.disconnectConnection({
			connectionId: subscription.connection_id,
		});
		const drainResult = await drainHostedRunner(
			{ reason: "ttl_expired", requestedBy: "platform" },
			{
				hostedRunner: {
					enabled: true,
					runnerSessionId: "mrs_restore_followup",
					workspaceRoot,
					snapshotRoot: join(workspaceRoot, ".maestro", "runner-snapshots"),
					activeMaestroSessionId: sessionId,
				},
				drainRuntime: vi.fn().mockResolvedValue({
					sessionId,
					sessionFile: sessionManager.getSessionFile(),
					protocolVersion: HEADLESS_PROTOCOL_VERSION,
					cursor: runtime.getSnapshot().cursor,
					snapshot: runtime.getSnapshot(),
					recordPlatformDrain: vi.fn().mockResolvedValue(undefined),
				}),
				now: () => new Date("2026-04-23T00:00:00.000Z"),
			},
		);
		expect(drainResult?.manifest.work_continuity).toMatchObject({
			active_tool_count: 0,
			tracked_tool_count: 0,
			codex_subagent_tool_call_ids: [],
			codex_subagent_child_run_ids: [],
			codex_subagent_thread_ids: [],
		});
		expect(drainResult?.manifest.work_continuity).not.toHaveProperty(
			"codex_subagent_edges",
		);

		await runtime.dispose();
	});

	it.each([
		{
			flushStatus: "failed" as const,
			runtimeError: "worker exited before flushing runtime state",
			expectedStatus: "Restore interrupted before runtime flush completed",
			expectedError: "worker exited before flushing runtime state",
		},
		{
			flushStatus: "interrupted" as const,
			runtimeError: "legacy runner interrupted the flush",
			expectedStatus: "Restore interrupted before runtime flush completed",
			expectedError: "legacy runner interrupted the flush",
		},
		{
			flushStatus: "skipped" as const,
			expectedStatus: "Restore incomplete: runtime flush skipped",
			expectedError:
				"runtime flush was skipped; no runtime activity was persisted",
		},
	])(
		"restores $flushStatus manifest into inspect-only state without stale runtime resources",
		async (testCase) => {
			const workspaceRoot = await mkdtemp(
				join(tmpdir(), "maestro-headless-restore-incomplete-"),
			);
			const sessionDir = await mkdtemp(join(tmpdir(), "maestro-sessions-"));
			tempDirs.push(workspaceRoot, sessionDir);
			const fakeAgent = new FakeAgent();
			const sessionManager = new SessionManager(false, undefined, {
				sessionDir,
			});
			sessionManager.startSession(fakeAgent.state);
			const sessionId = sessionManager.getSessionId();
			const createNativeClient = vi.fn(() => createMockNativeClient());
			const manifestPath = join(workspaceRoot, "restore-manifest.json");
			await writeFile(
				manifestPath,
				JSON.stringify(
					buildRestoreManifest({
						sessionId,
						sessionFile: sessionManager.getSessionFile(),
						workspaceRoot,
						flushStatus: testCase.flushStatus,
						runtimeError: testCase.runtimeError,
					}),
				),
				"utf8",
			);

			const service = new HeadlessRuntimeService();
			const runtime = await service.ensureRuntime({
				scope_key: "anon",
				registeredModel: TEST_MODEL,
				thinkingLevel: "off",
				approvalMode: "prompt",
				createNativeClient: () =>
					createNativeClient() as unknown as NativeHeadlessClient,
				context: {
					hostedRunner: {
						enabled: true,
						runnerSessionId: "mrs_restore",
						workspaceRoot,
						restoreManifestPath: manifestPath,
					},
				},
				sessionManager,
			});
			expect(createNativeClient).not.toHaveBeenCalled();

			expect(runtime.getSnapshot()).toMatchObject({
				session_id: sessionId,
				cursor: 7,
				state: {
					is_ready: false,
					is_responding: false,
					last_status: testCase.expectedStatus,
					last_error: testCase.expectedError,
					last_error_type: "protocol",
					connection_count: 0,
					connections: [],
					controller_connection_id: null,
					controller_subscription_id: null,
					client_protocol_version: undefined,
					client_info: undefined,
					capabilities: undefined,
					opt_out_notifications: undefined,
					connection_role: undefined,
					current_response: undefined,
					subscriber_count: 0,
					active_tools: [],
					active_file_watches: [],
					active_utility_commands: [],
					pending_approvals: [],
					pending_client_tools: [],
					pending_mcp_elicitations: [],
					pending_requests: [],
					pending_user_inputs: [],
					pending_tool_retries: [],
					tracked_tools: [],
					codex_subagent_edges: [],
				},
			});
			expect(runtime.getFleetAgentInstance().activeTasks).toMatchObject({
				activeTools: 0,
				fileWatches: 0,
				total: 0,
				utilityCommands: 0,
			});
			expect(runtime.getFleetAgentInstance()).toMatchObject({
				activeTasks: { total: 0 },
				resourceUtilization: {
					activeTasks: 0,
					connections: 0,
					subscribers: 0,
				},
			});
			expect(runtime.replayFrom(0)).toEqual([
				expect.objectContaining({
					type: "reset",
					reason: "restored_from_snapshot",
					snapshot: expect.objectContaining({
						session_id: sessionId,
						cursor: 7,
						state: expect.objectContaining({
							is_ready: false,
							last_status: testCase.expectedStatus,
							last_error: testCase.expectedError,
							connection_count: 0,
							connections: [],
							controller_connection_id: null,
							controller_subscription_id: null,
							client_protocol_version: undefined,
							client_info: undefined,
							capabilities: undefined,
							opt_out_notifications: undefined,
							connection_role: undefined,
							current_response: undefined,
							subscriber_count: 0,
							active_tools: [],
							active_file_watches: [],
							active_utility_commands: [],
							pending_client_tools: [],
							pending_mcp_elicitations: [],
							pending_requests: [],
							pending_user_inputs: [],
							tracked_tools: [],
							codex_subagent_edges: [],
						}),
					}),
				}),
			]);
			expect(() => runtime.createSubscription({ role: "viewer" })).toThrow(
				/not ready for new attachments/,
			);
			expect(() => runtime.registerConnection({ role: "controller" })).toThrow(
				/not ready for new attachments/,
			);
			expect(runtime.getSnapshot().state.connection_count).toBe(0);
			await expect(
				runtime.send({ type: "prompt", content: "after incomplete restore" }),
			).rejects.toThrow(/not ready for controller messages/);
			await expect(runtime.send({ type: "interrupt" })).rejects.toThrow(
				/not ready for controller messages/,
			);
			expect(runtime.getSnapshot().state.connection_count).toBe(0);
			const replayStream = runtime.createImplicitStream({
				cursor: 0,
				role: "viewer",
			});
			expect(replayStream.next()).toEqual(
				expect.objectContaining({
					type: "reset",
					reason: "restored_from_snapshot",
					snapshot: expect.objectContaining({
						session_id: sessionId,
						state: expect.objectContaining({
							is_ready: false,
							last_status: testCase.expectedStatus,
							connection_count: 0,
							connections: [],
							controller_connection_id: null,
							controller_subscription_id: null,
							client_protocol_version: undefined,
							client_info: undefined,
							capabilities: undefined,
							opt_out_notifications: undefined,
							connection_role: undefined,
							current_response: undefined,
							subscriber_count: 0,
							active_tools: [],
							active_file_watches: [],
							active_utility_commands: [],
							pending_client_tools: [],
							pending_mcp_elicitations: [],
							pending_requests: [],
							pending_user_inputs: [],
							tracked_tools: [],
							codex_subagent_edges: [],
						}),
					}),
				}),
			);
			replayStream.close();
			expect(() =>
				runtime.assertCanSend("controller", null, null, {
					allowNotReady: true,
				}),
			).not.toThrow();
			await expect(runtime.send({ type: "shutdown" })).resolves.toBeUndefined();
			expect(runtime.isDisposed()).toBe(true);

			await runtime.dispose();
		},
	);

	it.each([
		{
			field: "missing snapshot.state.session_id",
			apply: (manifest: ReturnType<typeof buildRestoreManifest>) => {
				delete manifest.snapshot.state.session_id;
			},
		},
		{
			field: "null snapshot.state.session_id",
			apply: (manifest: ReturnType<typeof buildRestoreManifest>) => {
				manifest.snapshot.state.session_id = null;
			},
		},
	])("accepts restore manifest with $field", async (testCase) => {
		const workspaceRoot = await mkdtemp(
			join(tmpdir(), "maestro-headless-restore-compatible-"),
		);
		const sessionDir = await mkdtemp(join(tmpdir(), "maestro-sessions-"));
		tempDirs.push(workspaceRoot, sessionDir);
		const fakeAgent = new FakeAgent();
		const sessionManager = new SessionManager(false, undefined, { sessionDir });
		sessionManager.startSession(fakeAgent.state);
		const manifest = buildRestoreManifest({
			sessionId: sessionManager.getSessionId(),
			sessionFile: sessionManager.getSessionFile(),
			workspaceRoot,
		});
		testCase.apply(manifest);
		const manifestPath = join(workspaceRoot, "restore-manifest.json");
		await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

		await expect(
			loadHostedRunnerRestoreManifest(manifestPath),
		).resolves.toEqual(
			expect.objectContaining({
				maestro_session_id: sessionManager.getSessionId(),
			}),
		);
	});

	it.each([
		{
			field: "snapshot.session_id",
			applyMismatch: (manifest: ReturnType<typeof buildRestoreManifest>) => {
				manifest.snapshot.session_id = "other-session";
			},
			message:
				"Hosted runner restore manifest snapshot is for Maestro session other-session",
		},
		{
			field: "snapshot.state.session_id",
			applyMismatch: (manifest: ReturnType<typeof buildRestoreManifest>) => {
				manifest.snapshot.state.session_id = "other-session";
			},
			message:
				"Hosted runner restore manifest snapshot state is for Maestro session other-session",
		},
		{
			field: "runtime.session_id",
			applyMismatch: (manifest: ReturnType<typeof buildRestoreManifest>) => {
				manifest.runtime.session_id = "other-session";
			},
			message:
				"Hosted runner restore manifest runtime is for Maestro session other-session",
		},
	])("rejects restore manifest with mismatched $field", async (testCase) => {
		const workspaceRoot = await mkdtemp(
			join(tmpdir(), "maestro-headless-restore-mismatch-"),
		);
		const sessionDir = await mkdtemp(join(tmpdir(), "maestro-sessions-"));
		tempDirs.push(workspaceRoot, sessionDir);
		const fakeAgent = new FakeAgent();
		const sessionManager = new SessionManager(false, undefined, { sessionDir });
		sessionManager.startSession(fakeAgent.state);
		const manifest = buildRestoreManifest({
			sessionId: sessionManager.getSessionId(),
			sessionFile: sessionManager.getSessionFile(),
			workspaceRoot,
		});
		testCase.applyMismatch(manifest);
		const manifestPath = join(workspaceRoot, "restore-manifest.json");
		await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

		await expect(loadHostedRunnerRestoreManifest(manifestPath)).rejects.toThrow(
			testCase.message,
		);
	});
});

describe("HeadlessRuntimeService native backend", () => {
	afterEach(async () => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		await Promise.all(
			tempDirs
				.splice(0)
				.map((dir) => rm(dir, { force: true, recursive: true })),
		);
	});

	it("uses injected NativeHeadlessClient when native mode is enabled", async () => {
		const workspaceRoot = await mkdtemp(
			join(tmpdir(), "maestro-headless-native-"),
		);
		const sessionDir = await mkdtemp(join(tmpdir(), "maestro-sessions-"));
		tempDirs.push(workspaceRoot, sessionDir);

		const mockClient = createMockNativeClient();
		const sessionManager = new SessionManager(false, undefined, { sessionDir });
		const saveMessage = vi.spyOn(sessionManager, "saveMessage");
		const loadAllSessions = vi
			.spyOn(sessionManager, "loadAllSessions")
			.mockReturnValue([]);

		const service = new HeadlessRuntimeService();
		const runtime = await service.ensureRuntime({
			scope_key: "anon",
			registeredModel: TEST_MODEL,
			thinkingLevel: "low",
			approvalMode: "prompt",
			createNativeClient: () => mockClient as unknown as NativeHeadlessClient,
			context: { hostedRunner: undefined },
			sessionManager,
		});

		expect(runtime.isNativeBackend()).toBe(true);
		expect(mockClient.start).toHaveBeenCalledOnce();
		expect(mockClient.hello).toHaveBeenCalled();
		expect(mockClient.init).toHaveBeenCalledWith(
			expect.objectContaining({
				thinking_level: "low",
				approval_mode: "prompt",
			}),
		);
		expect(loadAllSessions).toHaveBeenCalledOnce();
		expect(runtime.getSnapshot().state.is_ready).toBe(true);

		await runtime.send({
			type: "init",
			history: [{ role: "user", content: "prior turn" }],
			approval_mode: "prompt",
		});
		expect(mockClient.init).toHaveBeenLastCalledWith({
			history: [{ role: "user", content: "prior turn" }],
			approval_mode: "prompt",
		});

		await runtime.send({
			type: "prompt",
			content: "hello native",
			attachments: ["/tmp/report.pdf"],
		});
		expect(mockClient.prompt).toHaveBeenCalledWith("hello native", [
			"/tmp/report.pdf",
		]);
		expect(saveMessage).toHaveBeenCalledWith({
			role: "user",
			content: "hello native",
			metadata: { attachments: ["/tmp/report.pdf"] },
			timestamp: expect.any(Number),
		});

		saveMessage.mockImplementationOnce(() => {
			throw new Error("session storage unavailable");
		});
		expect(() =>
			mockClient.emit("message", {
				type: "response_end",
				response_id: "r1",
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					cache_read_tokens: 0,
					cache_write_tokens: 0,
					total_tokens: 2,
					total_cost_usd: 0,
					model_id: TEST_MODEL.id,
					provider: TEST_MODEL.provider,
				},
				tools_summary: {
					tools_used: [],
					calls_succeeded: 0,
					calls_failed: 0,
				},
				duration_ms: 1,
			}),
		).not.toThrow();
		expect(runtime.replayFrom(0)).toContainEqual(
			expect.objectContaining({
				type: "message",
				message: expect.objectContaining({
					type: "response_end",
					response_id: "r1",
				}),
			}),
		);
		await expect(
			runtime.send({ type: "prompt", content: "again" }),
		).rejects.toThrow(/already processing/);

		mockClient.emit("message", {
			type: "response_end",
			response_id: "done",
			usage: {
				input_tokens: 0,
				output_tokens: 0,
				cache_read_tokens: 0,
				cache_write_tokens: 0,
				total_tokens: 0,
				total_cost_usd: 0,
				model_id: TEST_MODEL.id,
				provider: TEST_MODEL.provider,
			},
			tools_summary: {
				tools_used: [],
				calls_succeeded: 0,
				calls_failed: 0,
			},
			duration_ms: 0,
		});
		expect(runtime.getFleetAgentInstance().errorStats).toMatchObject({
			runs: 1,
			errors: 0,
		});

		await runtime.send({
			type: "tool_response",
			call_id: "c1",
			approved: true,
		});
		expect(mockClient.send).toHaveBeenCalledWith(
			expect.objectContaining({ type: "tool_response", call_id: "c1" }),
		);

		await runtime.dispose();
		expect(mockClient.stop).toHaveBeenCalled();
	});

	it("throws when native start fails (no soft TS fallback)", async () => {
		const sessionDir = await mkdtemp(join(tmpdir(), "maestro-sessions-"));
		tempDirs.push(sessionDir);
		const sessionManager = new SessionManager(false, undefined, { sessionDir });
		sessionManager.startSession({
			model: TEST_MODEL,
			systemPrompt: "",
			thinkingLevel: "off",
			tools: [],
			messages: [],
		});

		const service = new HeadlessRuntimeService();
		await expect(
			service.ensureRuntime({
				scope_key: "anon",
				registeredModel: TEST_MODEL,
				thinkingLevel: "off",
				approvalMode: "prompt",
				createNativeClient: () => {
					const mock = new EventEmitter() as EventEmitter & {
						start: () => Promise<never>;
						stop: () => void;
					};
					mock.start = async () => {
						throw new Error("binary missing");
					};
					mock.stop = () => {};
					return mock as unknown as NativeHeadlessClient;
				},
				context: {},
				sessionManager,
			}),
		).rejects.toThrow("binary missing");
	});

	it("stops the native client when session initialization fails", async () => {
		const sessionDir = await mkdtemp(join(tmpdir(), "maestro-sessions-"));
		tempDirs.push(sessionDir);
		const sessionManager = new SessionManager(false, undefined, { sessionDir });
		vi.spyOn(sessionManager, "loadAllSessions").mockReturnValue([]);
		vi.spyOn(sessionManager, "startSession").mockImplementation(() => {
			throw new Error("session storage unavailable");
		});
		const mockClient = createMockNativeClient();

		const service = new HeadlessRuntimeService();
		await expect(
			service.ensureRuntime({
				scope_key: "anon",
				registeredModel: TEST_MODEL,
				thinkingLevel: "off",
				approvalMode: "prompt",
				createNativeClient: () => mockClient as unknown as NativeHeadlessClient,
				context: {},
				sessionManager,
			}),
		).rejects.toThrow("session storage unavailable");
		expect(mockClient.stop).toHaveBeenCalledOnce();
	});

	it.each([
		{
			name: "client tools",
			options: {
				enableClientTools: true,
				capabilities: { server_requests: ["client_tool"] as const },
			},
			message: "Native headless runtime does not yet support client-side tools",
		},
		{
			name: "VS Code tools",
			options: { client: "vscode" as const },
			message:
				"Native headless runtime does not yet support vscode client tools",
		},
		{
			name: "user input requests",
			options: {
				capabilities: { server_requests: ["user_input"] as const },
			},
			message:
				"Native headless runtime does not yet support user_input server requests",
		},
		{
			name: "MCP elicitation requests",
			options: {
				capabilities: { server_requests: ["mcp_elicitation"] as const },
			},
			message:
				"Native headless runtime does not yet support mcp_elicitation server requests",
		},
	])(
		"rejects $name before starting the native backend",
		async ({ options, message }) => {
			const sessionDir = await mkdtemp(join(tmpdir(), "maestro-sessions-"));
			tempDirs.push(sessionDir);
			const sessionManager = new SessionManager(false, undefined, {
				sessionDir,
			});
			const createNativeClient = vi.fn(() => createMockNativeClient());

			const service = new HeadlessRuntimeService();
			await expect(
				service.ensureRuntime({
					scope_key: "anon",
					registeredModel: TEST_MODEL,
					thinkingLevel: "off",
					approvalMode: "prompt",
					...options,
					createNativeClient: () =>
						createNativeClient() as unknown as NativeHeadlessClient,
					context: {},
					sessionManager,
				}),
			).rejects.toThrow(message);
			expect(createNativeClient).not.toHaveBeenCalled();
		},
	);
});
