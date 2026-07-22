import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RegisteredModel } from "../../src/models/registry.js";
import { HeadlessRuntimeService } from "../../src/server/headless-runtime-service.js";
import type { NativeHeadlessClient } from "../../src/server/native-headless-client.js";
import { SessionManager } from "../../src/session/manager.js";

const resolveNativeSystemPrompt = vi.hoisted(() =>
	vi.fn(async () => ({
		systemPrompt: "resolved native prompt",
		promptMetadata: {
			name: "maestro-system",
			label: "production",
			hash: "headless-prompt-hash",
			source: "bundled" as const,
		},
		promptContextManifest: {
			cwd: "/workspace",
			candidates: [],
			bytesRead: 0,
			entries: [],
			diagnostics: [],
		},
		systemPromptSourcePaths: ["/workspace/APPEND_SYSTEM.md"],
	})),
);

vi.mock("../../src/server/native-system-prompt.js", () => ({
	resolveNativeSystemPrompt,
}));

const TEST_MODEL: RegisteredModel = {
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1/responses",
	reasoning: true,
	toolUse: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
	providerName: "OpenAI",
	source: "builtin",
	isLocal: false,
};

function createMockNativeClient() {
	const client = new EventEmitter() as EventEmitter & {
		start: ReturnType<typeof vi.fn>;
		stop: ReturnType<typeof vi.fn>;
		hello: ReturnType<typeof vi.fn>;
		init: ReturnType<typeof vi.fn>;
		send: ReturnType<typeof vi.fn>;
	};
	client.start = vi.fn(async () => ({
		type: "ready" as const,
		protocol_version: "1.0",
		model: TEST_MODEL.id,
		provider: TEST_MODEL.provider,
		session_id: null,
	}));
	client.stop = vi.fn();
	client.hello = vi.fn();
	client.init = vi.fn();
	client.send = vi.fn();
	return client;
}

const tempDirs: string[] = [];

afterEach(async () => {
	resolveNativeSystemPrompt.mockClear();
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
	);
});

describe("HeadlessRuntimeService profile handling", () => {
	it("passes profile and CLI overrides into native prompt resolution", async () => {
		const workspaceRoot = await mkdtemp(
			join(tmpdir(), "maestro-headless-profile-"),
		);
		const sessionDir = await mkdtemp(join(tmpdir(), "maestro-sessions-"));
		tempDirs.push(workspaceRoot, sessionDir);
		const sessionManager = new SessionManager(false, undefined, { sessionDir });
		const client = createMockNativeClient();
		const cliOverrides = {
			projects: { "/tmp/project": { trust_level: "trusted" as const } },
		};
		const service = new HeadlessRuntimeService();

		const runtime = await service.ensureRuntime({
			scope_key: "anon",
			registeredModel: TEST_MODEL,
			thinkingLevel: "off",
			approvalMode: "prompt",
			workspaceRoot,
			createNativeClient: () => client as unknown as NativeHeadlessClient,
			context: { profileName: "web-work", cliOverrides },
			sessionManager,
		});

		expect(resolveNativeSystemPrompt).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: workspaceRoot,
				profileName: "web-work",
				cliOverrides,
			}),
		);
		expect(client.init).toHaveBeenCalledWith(
			expect.objectContaining({
				approval_mode: "prompt",
				system_prompt: "resolved native prompt",
			}),
		);
		expect(sessionManager.getHeader()).toEqual(
			expect.objectContaining({
				promptMetadata: expect.objectContaining({
					hash: "headless-prompt-hash",
				}),
				promptContextManifest: expect.objectContaining({
					cwd: "/workspace",
				}),
				systemPromptSourcePaths: ["/workspace/APPEND_SYSTEM.md"],
			}),
		);
		await runtime.dispose();
	});
});
