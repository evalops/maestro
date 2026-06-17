import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
	AgentEvent,
	AppMessage,
	ThinkingLevel,
} from "../../src/agent/types.js";
import type { RegisteredModel } from "../../src/models/registry.js";
import { HeadlessRuntimeService } from "../../src/server/headless-runtime-service.js";
import { SessionManager } from "../../src/session/manager.js";

const runUserPromptWithRecovery = vi.hoisted(() =>
	vi.fn(async (options: { execute: () => Promise<unknown> }) => {
		await options.execute();
	}),
);

vi.mock("../../src/agent/user-prompt-runtime.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../src/agent/user-prompt-runtime.js")
	>("../../src/agent/user-prompt-runtime.js");
	return {
		...actual,
		runUserPromptWithRecovery,
	};
});

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
	prompt = vi.fn().mockResolvedValue(undefined);

	subscribe(_listener: (event: AgentEvent) => void) {
		return () => {};
	}

	abort() {}
}

const tempDirs: string[] = [];

afterEach(async () => {
	runUserPromptWithRecovery.mockClear();
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
	);
});

describe("HeadlessRuntimeService profile handling", () => {
	it("passes the web profile into hosted runtime agents and prompt recovery", async () => {
		const workspaceRoot = await mkdtemp(
			join(tmpdir(), "maestro-headless-profile-"),
		);
		const sessionDir = await mkdtemp(join(tmpdir(), "maestro-sessions-"));
		tempDirs.push(workspaceRoot, sessionDir);
		const fakeAgent = new FakeAgent();
		const sessionManager = new SessionManager(false, undefined, { sessionDir });
		sessionManager.startSession(fakeAgent.state);
		const createAgent = vi.fn().mockResolvedValue(fakeAgent);
		const service = new HeadlessRuntimeService();

		const runtime = await service.ensureRuntime({
			scope_key: "anon",
			registeredModel: TEST_MODEL,
			thinkingLevel: "off",
			approvalMode: "prompt",
			workspaceRoot,
			context: {
				createAgent,
				createBackgroundAgent: vi.fn().mockResolvedValue(new FakeAgent()),
				hostedRunner: {
					enabled: true,
					runnerSessionId: "mrs_profile",
					workspaceRoot,
				},
				profileName: "web-work",
				cliOverrides: {
					projects: { "/tmp/project": { trust_level: "trusted" } },
				},
			},
			sessionManager,
		});

		expect(createAgent).toHaveBeenCalledWith(
			TEST_MODEL,
			"off",
			"prompt",
			expect.objectContaining({
				profileName: "web-work",
				cliOverrides: {
					projects: { "/tmp/project": { trust_level: "trusted" } },
				},
			}),
		);

		await runtime.send({ type: "prompt", content: "continue" });

		await vi.waitFor(() => {
			expect(runUserPromptWithRecovery).toHaveBeenCalledWith(
				expect.objectContaining({
					profileName: "web-work",
					cliOverrides: {
						projects: { "/tmp/project": { trust_level: "trusted" } },
					},
					prompt: "continue",
				}),
			);
		});
		expect(fakeAgent.prompt).toHaveBeenCalledWith("continue", undefined);
	});
});
