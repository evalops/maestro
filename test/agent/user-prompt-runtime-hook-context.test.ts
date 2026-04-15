import { vi } from "vitest";

const { buildCompactionHookContextMock, runWithPromptRecoveryMock } =
	vi.hoisted(() => ({
		buildCompactionHookContextMock: vi.fn(
			(
				sessionManager: { getSessionId?: () => string | undefined },
				cwd: string,
				signal?: AbortSignal,
			) => ({
				cwd,
				sessionId: sessionManager.getSessionId?.(),
				signal,
			}),
		),
		runWithPromptRecoveryMock: vi.fn(async () => {}),
	}));

vi.mock("../../src/agent/compaction-hooks.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../src/agent/compaction-hooks.js")
	>("../../src/agent/compaction-hooks.js");
	return {
		...actual,
		buildCompactionHookContext: buildCompactionHookContextMock,
	};
});

vi.mock("../../src/agent/prompt-recovery.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../src/agent/prompt-recovery.js")
	>("../../src/agent/prompt-recovery.js");
	return {
		...actual,
		runWithPromptRecovery: runWithPromptRecoveryMock,
	};
});

import { beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../../src/agent/agent.js";
import type { Model } from "../../src/agent/types.js";
import { runUserPromptWithRecovery } from "../../src/agent/user-prompt-runtime.js";
import { MockTransport } from "./mock-transport.js";

const mockModel: Model<"openai-completions"> = {
	id: "mock",
	name: "Mock",
	provider: "mock",
	api: "openai-completions",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	},
	contextWindow: 8192,
	maxTokens: 2048,
};

describe("user prompt runtime hook context", () => {
	beforeEach(() => {
		buildCompactionHookContextMock.mockClear();
		runWithPromptRecoveryMock.mockClear();
	});

	it("passes the caller abort signal into compaction hook context", async () => {
		const agent = new Agent({
			transport: new MockTransport(),
			initialState: {
				model: mockModel,
				tools: [],
				systemPrompt: "Base system prompt",
			},
		});
		const abortController = new AbortController();
		const sessionManager = {
			getSessionId: () => "session-hook-context",
			saveMessage: vi.fn(),
		};

		await runUserPromptWithRecovery({
			agent,
			sessionManager: sessionManager as never,
			cwd: "/tmp/hook-context",
			prompt: "Investigate the issue",
			signal: abortController.signal,
			execute: async () => {},
		});

		expect(buildCompactionHookContextMock).toHaveBeenCalledWith(
			sessionManager,
			"/tmp/hook-context",
			abortController.signal,
		);
		expect(runWithPromptRecoveryMock).toHaveBeenCalledWith(
			expect.objectContaining({
				hookContext: expect.objectContaining({
					signal: abortController.signal,
				}),
			}),
		);
	});
});
