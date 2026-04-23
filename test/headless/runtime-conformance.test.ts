import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	HeadlessRuntimeHeartbeatSnapshotSchema,
	HeadlessRuntimeSnapshotSchema,
	HeadlessRuntimeStreamEnvelopeSchema,
	HeadlessRuntimeSubscriptionSnapshotSchema,
} from "@evalops/contracts";
import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
	ActionApprovalDecision,
	ActionApprovalRequest,
	ApprovalMode,
} from "../../src/agent/action-approval.js";
import type {
	AgentEvent,
	AppMessage,
	Attachment,
	ThinkingLevel,
} from "../../src/agent/types.js";
import {
	HEADLESS_PROTOCOL_VERSION,
	type HeadlessClientCapabilities,
	type HeadlessToAgentMessage,
} from "../../src/cli/headless-protocol.js";
import type { RegisteredModel } from "../../src/models/registry.js";
import { HeadlessInProcessHost } from "../../src/server/headless-in-process-host.js";
import {
	type HeadlessAttachedSubscription,
	type HeadlessRuntimeConnectionClosedSnapshot,
	type HeadlessRuntimeHeartbeatSnapshot,
	HeadlessRuntimeService,
	type HeadlessRuntimeSnapshot,
	type HeadlessRuntimeStreamEnvelope,
	type HeadlessRuntimeSubscriptionSnapshot,
} from "../../src/server/headless-runtime-service.js";
import { serverRequestManager } from "../../src/server/server-request-manager.js";
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

const DEFAULT_CAPABILITIES: HeadlessClientCapabilities = {
	server_requests: ["approval", "client_tool", "tool_retry"],
	utility_operations: [
		"command_exec",
		"file_search",
		"file_read",
		"file_watch",
	],
	raw_agent_events: true,
};

class FakeAgent {
	state = {
		model: TEST_MODEL,
		systemPrompt: "",
		thinkingLevel: "off" as ThinkingLevel,
		tools: [],
		messages: [] as AppMessage[],
	};
	prompts: Array<{ content: string; attachments?: Attachment[] }> = [];
	aborts = 0;
	private readonly listeners = new Set<(event: AgentEvent) => void>();

	subscribe(listener: (event: AgentEvent) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	setSystemPrompt(value: string) {
		this.state.systemPrompt = value;
	}

	setThinkingLevel(level: ThinkingLevel) {
		this.state.thinkingLevel = level;
	}

	abort() {
		this.aborts += 1;
	}

	async prompt(content: string, attachments?: Attachment[]) {
		this.prompts.push({ content, attachments });
		this.emit({
			type: "status",
			status: `Prompt: ${content}`,
			details: {},
		});
	}

	emit(event: AgentEvent) {
		for (const listener of this.listeners) {
			listener(event);
		}
	}
}

interface StartOptions {
	approvalMode?: ApprovalMode;
	capabilities?: HeadlessClientCapabilities;
}

interface SendOptions {
	role?: "viewer" | "controller";
	connectionId?: string | null;
	subscriptionId?: string | null;
}

interface RuntimeConformanceAdapter {
	readonly label: string;
	readonly workspaceRoot: string;
	readonly outsideRoot: string;
	start(options?: StartOptions): Promise<HeadlessRuntimeSnapshot>;
	subscribe(options: {
		role?: "viewer" | "controller";
		takeControl?: boolean;
	}): HeadlessRuntimeSubscriptionSnapshot;
	attachStream(options: {
		role?: "viewer" | "controller";
		cursor?: number | null;
	}): HeadlessAttachedSubscription;
	send(
		message: HeadlessToAgentMessage,
		options?: SendOptions,
	): Promise<HeadlessRuntimeSnapshot>;
	heartbeat(options: {
		connectionId?: string | null;
		subscriptionId?: string | null;
	}): HeadlessRuntimeHeartbeatSnapshot;
	disconnect(options: {
		connectionId?: string | null;
		subscriptionId?: string | null;
	}): Promise<HeadlessRuntimeConnectionClosedSnapshot>;
	replayFrom(cursor: number): HeadlessRuntimeStreamEnvelope[] | null;
	emitAgentEvent(event: AgentEvent): void;
	requestApproval(
		request: ActionApprovalRequest,
	): Promise<ActionApprovalDecision>;
	close(): Promise<void>;
}

class TypeScriptInProcessConformanceAdapter
	implements RuntimeConformanceAdapter
{
	readonly label = "typescript-in-process";
	readonly scopeKey = "runtime-conformance";
	workspaceRoot = "";
	outsideRoot = "";
	private sessionDir = "";
	private sessionId = "";
	private fakeAgent = new FakeAgent();
	private runtimeService = new HeadlessRuntimeService();
	private host = new HeadlessInProcessHost(this.runtimeService);

	async start(options: StartOptions = {}): Promise<HeadlessRuntimeSnapshot> {
		this.sessionDir = await mkdtemp(
			join(tmpdir(), "maestro-conformance-sessions-"),
		);
		this.workspaceRoot = await mkdtemp(
			join(tmpdir(), "maestro-conformance-workspace-"),
		);
		this.outsideRoot = await mkdtemp(
			join(tmpdir(), "maestro-conformance-outside-"),
		);
		await writeFile(
			join(this.workspaceRoot, "notes.md"),
			"alpha\nbeta\ngamma\n",
		);
		await writeFile(join(this.outsideRoot, "secret.txt"), "not in workspace\n");

		const sessionManager = new SessionManager(false, undefined, {
			sessionDir: this.sessionDir,
		});
		const snapshot = await this.host.ensureSession({
			scope_key: this.scopeKey,
			registeredModel: TEST_MODEL,
			thinkingLevel: "off",
			approvalMode: options.approvalMode ?? "prompt",
			context: {
				createAgent: vi.fn().mockResolvedValue(this.fakeAgent),
			},
			sessionManager,
			clientProtocolVersion: HEADLESS_PROTOCOL_VERSION,
			clientInfo: {
				name: "maestro-conformance",
				version: "0.1.0",
			},
			capabilities: options.capabilities ?? DEFAULT_CAPABILITIES,
			role: "controller",
		});
		this.sessionId = snapshot.session_id;
		return snapshot;
	}

	subscribe(options: {
		role?: "viewer" | "controller";
		takeControl?: boolean;
	}): HeadlessRuntimeSubscriptionSnapshot {
		return this.host.subscribe({
			scopeKey: this.scopeKey,
			sessionId: this.requireSessionId(),
			role: options.role,
			takeControl: options.takeControl,
		});
	}

	attachStream(options: {
		role?: "viewer" | "controller";
		cursor?: number | null;
	}): HeadlessAttachedSubscription {
		return this.host.attachStream({
			scopeKey: this.scopeKey,
			sessionId: this.requireSessionId(),
			role: options.role,
			cursor: options.cursor,
		});
	}

	async send(
		message: HeadlessToAgentMessage,
		options: SendOptions = {},
	): Promise<HeadlessRuntimeSnapshot> {
		return await this.host.send({
			scopeKey: this.scopeKey,
			sessionId: this.requireSessionId(),
			role: options.role,
			connectionId: options.connectionId,
			subscriptionId: options.subscriptionId,
			message,
		});
	}

	heartbeat(options: {
		connectionId?: string | null;
		subscriptionId?: string | null;
	}): HeadlessRuntimeHeartbeatSnapshot {
		return this.host.heartbeat({
			scopeKey: this.scopeKey,
			sessionId: this.requireSessionId(),
			connectionId: options.connectionId,
			subscriptionId: options.subscriptionId,
		});
	}

	async disconnect(options: {
		connectionId?: string | null;
		subscriptionId?: string | null;
	}): Promise<HeadlessRuntimeConnectionClosedSnapshot> {
		return await this.host.disconnect({
			scopeKey: this.scopeKey,
			sessionId: this.requireSessionId(),
			connectionId: options.connectionId,
			subscriptionId: options.subscriptionId,
		});
	}

	replayFrom(cursor: number): HeadlessRuntimeStreamEnvelope[] | null {
		return this.host.replayFrom(this.scopeKey, this.requireSessionId(), cursor);
	}

	emitAgentEvent(event: AgentEvent): void {
		this.fakeAgent.emit(event);
	}

	async requestApproval(
		request: ActionApprovalRequest,
	): Promise<ActionApprovalDecision> {
		const runtime = this.runtimeService.getRuntime(
			this.scopeKey,
			this.requireSessionId(),
		);
		if (!runtime) {
			throw new Error("Headless runtime not found");
		}
		const approvalService = (
			runtime as unknown as {
				approvalService: {
					requestApproval(
						request: ActionApprovalRequest,
					): Promise<ActionApprovalDecision>;
				};
			}
		).approvalService;
		return await approvalService.requestApproval(request);
	}

	async close(): Promise<void> {
		if (this.sessionId) {
			await this.runtimeService
				.getRuntime(this.scopeKey, this.sessionId)
				?.dispose();
		}
		await Promise.all(
			[this.sessionDir, this.workspaceRoot, this.outsideRoot]
				.filter(Boolean)
				.map((path) => rm(path, { recursive: true, force: true })),
		);
	}

	private requireSessionId(): string {
		if (!this.sessionId) {
			throw new Error("Conformance adapter has not started a session");
		}
		return this.sessionId;
	}
}

async function readNextEnvelope(
	stream: HeadlessAttachedSubscription,
): Promise<HeadlessRuntimeStreamEnvelope> {
	const immediate = stream.next();
	if (immediate) {
		return immediate;
	}
	await new Promise<void>((resolve) => {
		const unsubscribe = stream.onAvailable(() => {
			unsubscribe();
			resolve();
		});
	});
	const next = stream.next();
	if (!next) {
		throw new Error("Expected next headless conformance envelope");
	}
	return next;
}

async function readUntil(
	stream: HeadlessAttachedSubscription,
	predicate: (envelope: HeadlessRuntimeStreamEnvelope) => boolean,
): Promise<HeadlessRuntimeStreamEnvelope[]> {
	const envelopes: HeadlessRuntimeStreamEnvelope[] = [];
	for (let index = 0; index < 20; index += 1) {
		const next = await readNextEnvelope(stream);
		envelopes.push(next);
		if (predicate(next)) {
			return envelopes;
		}
	}
	throw new Error("Timed out waiting for headless conformance envelope");
}

function expectRuntimeSnapshot(value: HeadlessRuntimeSnapshot): void {
	expect(Value.Check(HeadlessRuntimeSnapshotSchema, value)).toBe(true);
}

function expectStreamEnvelope(value: HeadlessRuntimeStreamEnvelope): void {
	expect(Value.Check(HeadlessRuntimeStreamEnvelopeSchema, value)).toBe(true);
}

function restoreEnvValue(name: string, value: string | undefined): void {
	if (value === undefined) {
		Reflect.deleteProperty(process.env, name);
		return;
	}
	process.env[name] = value;
}

function defineHeadlessRuntimeConformanceSuite(
	name: string,
	createAdapter: () => RuntimeConformanceAdapter,
) {
	describe(`${name} headless runtime conformance`, () => {
		let adapter: RuntimeConformanceAdapter | null = null;
		const originalHostedMode = process.env.MAESTRO_HOSTED_RUNNER_MODE;
		const originalWorkspaceRoot = process.env.MAESTRO_WORKSPACE_ROOT;

		async function start(
			options?: StartOptions,
		): Promise<RuntimeConformanceAdapter> {
			adapter = createAdapter();
			const snapshot = await adapter.start(options);
			expectRuntimeSnapshot(snapshot);
			return adapter;
		}

		afterEach(async () => {
			restoreEnvValue("MAESTRO_HOSTED_RUNNER_MODE", originalHostedMode);
			restoreEnvValue("MAESTRO_WORKSPACE_ROOT", originalWorkspaceRoot);
			for (const request of serverRequestManager.listPending()) {
				serverRequestManager.cancel(request.id, "Conformance cleanup");
			}
			await adapter?.close();
			adapter = null;
			vi.restoreAllMocks();
		});

		it("creates controller and viewer subscriptions with schema-valid heartbeat snapshots", async () => {
			const runtime = await start();
			const controller = runtime.subscribe({ role: "controller" });
			expect(
				Value.Check(HeadlessRuntimeSubscriptionSnapshotSchema, controller),
			).toBe(true);
			expect(controller.role).toBe("controller");
			expect(controller.controller_lease_granted).toBe(true);

			const viewer = runtime.subscribe({ role: "viewer" });
			expect(
				Value.Check(HeadlessRuntimeSubscriptionSnapshotSchema, viewer),
			).toBe(true);
			expect(viewer.role).toBe("viewer");
			expect(viewer.controller_lease_granted).toBe(false);
			expect(viewer.controller_connection_id).toBe(controller.connection_id);

			const controllerHeartbeat = runtime.heartbeat({
				subscriptionId: controller.subscription_id,
			});
			expect(
				Value.Check(
					HeadlessRuntimeHeartbeatSnapshotSchema,
					controllerHeartbeat,
				),
			).toBe(true);
			expect(controllerHeartbeat.controller_lease_granted).toBe(true);

			const viewerHeartbeat = runtime.heartbeat({
				subscriptionId: viewer.subscription_id,
			});
			expect(
				Value.Check(HeadlessRuntimeHeartbeatSnapshotSchema, viewerHeartbeat),
			).toBe(true);
			expect(viewerHeartbeat.controller_lease_granted).toBe(false);
		});

		it("enforces viewer read-only access and explicit controller takeover", async () => {
			const runtime = await start();
			const controller = runtime.subscribe({ role: "controller" });
			const viewer = runtime.subscribe({ role: "viewer" });

			await expect(
				runtime.send(
					{ type: "prompt", content: "viewer should not mutate" },
					{ role: "viewer", subscriptionId: viewer.subscription_id },
				),
			).rejects.toThrow("Viewer headless connections cannot send messages");

			expect(() => runtime.subscribe({ role: "controller" })).toThrow(
				"Controller lease is already held by another connection",
			);

			const takeover = runtime.subscribe({
				role: "controller",
				takeControl: true,
			});
			expect(takeover.controller_lease_granted).toBe(true);
			expect(takeover.controller_connection_id).toBe(takeover.connection_id);
			expect(
				runtime.heartbeat({ subscriptionId: controller.subscription_id })
					.controller_lease_granted,
			).toBe(false);

			await expect(
				runtime.send(
					{ type: "prompt", content: "old controller should not mutate" },
					{ role: "controller", subscriptionId: controller.subscription_id },
				),
			).rejects.toThrow(
				"Controller lease is currently held by another connection",
			);
		});

		it("replays cursor-ordered events and emits reset snapshots for replay gaps", async () => {
			const runtime = await start();
			const controller = runtime.subscribe({ role: "controller" });
			const stream = runtime.attachStream({ role: "viewer", cursor: null });
			const initial = await readNextEnvelope(stream);
			expectStreamEnvelope(initial);
			expect(initial.type).toBe("snapshot");

			await runtime.send(
				{ type: "init", system_prompt: "Conformance mode" },
				{ role: "controller", subscriptionId: controller.subscription_id },
			);
			await runtime.send(
				{ type: "prompt", content: "cursor replay" },
				{ role: "controller", subscriptionId: controller.subscription_id },
			);

			await vi.waitFor(() => {
				expect(
					runtime.replayFrom(0)?.some((entry) => {
						return (
							entry.type === "message" &&
							entry.message.type === "status" &&
							entry.message.message === "Prompt: cursor replay"
						);
					}),
				).toBe(true);
			});

			const replay = runtime.replayFrom(0) ?? [];
			expect(replay.length).toBeGreaterThan(0);
			for (const envelope of replay) {
				expectStreamEnvelope(envelope);
			}
			expect(
				replay.map((entry) =>
					entry.type === "message" ? entry.message.type : entry.type,
				),
			).toEqual(
				expect.arrayContaining(["ready", "session_info", "status", "status"]),
			);

			const resetStream = runtime.attachStream({
				role: "viewer",
				cursor: -999,
			});
			const reset = await readNextEnvelope(resetStream);
			expectStreamEnvelope(reset);
			expect(reset).toMatchObject({
				type: "reset",
				reason: "replay_gap",
			});
			resetStream.close();
			stream.close();
		});

		it("emits approval server requests and resolves them through the protocol response path", async () => {
			const runtime = await start();
			const controller = runtime.subscribe({ role: "controller" });
			const request: ActionApprovalRequest = {
				id: "call_conformance_approval",
				toolName: "bash",
				args: { command: "git push --force" },
				reason: "Conformance approval fixture",
			};

			runtime.emitAgentEvent({
				type: "action_approval_required",
				request,
			});
			const approval = runtime.requestApproval(request);

			await vi.waitFor(() => {
				expect(
					runtime.replayFrom(0)?.some((entry) => {
						return (
							entry.type === "message" &&
							entry.message.type === "server_request" &&
							entry.message.request_id === request.id
						);
					}),
				).toBe(true);
			});

			await runtime.send(
				{
					type: "server_request_response",
					request_id: request.id,
					request_type: "approval",
					approved: false,
					result: {
						success: false,
						output: "",
						error: "Denied in conformance",
					},
				},
				{ role: "controller", subscriptionId: controller.subscription_id },
			);

			await expect(approval).resolves.toEqual({
				approved: false,
				reason: "Denied in conformance",
				resolvedBy: "user",
			});
			expect(
				runtime.replayFrom(0)?.some((entry) => {
					return (
						entry.type === "message" &&
						entry.message.type === "server_request_resolved" &&
						entry.message.request_id === request.id &&
						entry.message.resolution === "denied"
					);
				}),
			).toBe(true);
		});

		it("scopes utility file reads to the hosted workspace root", async () => {
			const runtime = await start();
			process.env.MAESTRO_HOSTED_RUNNER_MODE = "1";
			process.env.MAESTRO_WORKSPACE_ROOT = runtime.workspaceRoot;

			const controller = runtime.subscribe({ role: "controller" });
			const stream = runtime.attachStream({ role: "viewer", cursor: null });
			expect((await readNextEnvelope(stream)).type).toBe("snapshot");

			await runtime.send(
				{
					type: "utility_file_read",
					read_id: "read_notes",
					path: "notes.md",
					cwd: runtime.workspaceRoot,
					limit: 2,
				},
				{ role: "controller", subscriptionId: controller.subscription_id },
			);
			const envelopes = await readUntil(
				stream,
				(envelope) =>
					envelope.type === "message" &&
					envelope.message.type === "utility_file_read_result" &&
					envelope.message.read_id === "read_notes",
			);
			for (const envelope of envelopes) {
				expectStreamEnvelope(envelope);
			}
			expect(envelopes.at(-1)).toMatchObject({
				type: "message",
				message: {
					type: "utility_file_read_result",
					read_id: "read_notes",
					relative_path: "notes.md",
					content: "alpha\nbeta",
					truncated: true,
				},
			});

			await expect(
				runtime.send(
					{
						type: "utility_file_read",
						read_id: "read_escape",
						path: join(runtime.outsideRoot, "secret.txt"),
						cwd: runtime.workspaceRoot,
					},
					{ role: "controller", subscriptionId: controller.subscription_id },
				),
			).rejects.toThrow(/outside|Access denied|Path is outside/);
			stream.close();
		});

		it("disconnects subscriptions and clears controller leases without destroying the runtime", async () => {
			const runtime = await start();
			const controller = runtime.subscribe({ role: "controller" });
			const viewer = runtime.subscribe({ role: "viewer" });

			const viewerDisconnect = await runtime.disconnect({
				connectionId: viewer.connection_id,
			});
			expect(viewerDisconnect).toEqual({
				success: true,
				connection_id: viewer.connection_id,
				controller_connection_id: controller.connection_id,
				disconnected_subscription_ids: [viewer.subscription_id],
			});

			const controllerDisconnect = await runtime.disconnect({
				connectionId: controller.connection_id,
			});
			expect(controllerDisconnect).toEqual({
				success: true,
				connection_id: controller.connection_id,
				controller_connection_id: null,
				disconnected_subscription_ids: [controller.subscription_id],
			});
			const replay = runtime.replayFrom(0) ?? [];
			expect(replay.length).toBeGreaterThan(0);
			expect(
				replay.every((envelope) =>
					Value.Check(HeadlessRuntimeStreamEnvelopeSchema, envelope),
				),
			).toBe(true);
		});
	});
}

defineHeadlessRuntimeConformanceSuite(
	"TypeScript in-process host",
	() => new TypeScriptInProcessConformanceAdapter(),
);
