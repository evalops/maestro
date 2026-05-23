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
} from "../../src/cli/headless-protocol.js";
import type { RegisteredModel } from "../../src/models/registry.js";
import {
	HeadlessRuntimeService,
	getFleetPlatformEventBusStatus,
	inferFleetModelTier,
} from "../../src/server/headless-runtime-service.js";
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

const tempDirs: string[] = [];

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
		const restoredState = createHeadlessRuntimeState();
		restoredState.protocol_version = HEADLESS_PROTOCOL_VERSION;
		restoredState.session_id = sessionId;
		restoredState.cwd = workspaceRoot;
		restoredState.pending_user_inputs = [
			{
				call_id: "call_user_input",
				tool: "ask_user",
				args: { question: "Continue?" },
			},
		];
		const manifestPath = join(workspaceRoot, "restore-manifest.json");
		await writeFile(
			manifestPath,
			JSON.stringify({
				protocol_version: "evalops.remote-runner.snapshot-manifest.v1",
				maestro_session_id: sessionId,
				runtime: {
					flush_status: "completed",
					session_id: sessionId,
					session_file: sessionManager.getSessionFile(),
					cursor: 7,
				},
				snapshot: {
					protocolVersion: HEADLESS_PROTOCOL_VERSION,
					session_id: sessionId,
					cursor: 7,
					last_init: null,
					state: restoredState,
				},
			}),
			"utf8",
		);

		const service = new HeadlessRuntimeService();
		const runtime = await service.ensureRuntime({
			scope_key: "anon",
			registeredModel: TEST_MODEL,
			thinkingLevel: "off",
			approvalMode: "prompt",
			context: {
				createAgent: vi.fn().mockResolvedValue(fakeAgent),
				createBackgroundAgent: vi.fn().mockResolvedValue(new FakeAgent()),
				hostedRunner: {
					enabled: true,
					runnerSessionId: "mrs_restore",
					workspaceRoot,
					restoreManifestPath: manifestPath,
				},
			},
			sessionManager,
		});

		expect(runtime.getSnapshot()).toMatchObject({
			session_id: sessionId,
			cursor: 7,
			state: {
				is_ready: true,
				last_status: "Restored from snapshot",
				pending_user_inputs: [
					{
						call_id: "call_user_input",
						tool: "ask_user",
					},
				],
			},
		});
		expect(runtime.replayFrom(0)).toEqual([
			expect.objectContaining({
				type: "reset",
				reason: "restored_from_snapshot",
				snapshot: expect.objectContaining({
					session_id: sessionId,
					cursor: 7,
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
				}),
			}),
		]);

		await runtime.dispose();
	});
});
