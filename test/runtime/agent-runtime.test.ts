import { beforeEach, describe, expect, it, vi } from "vitest";
import { runUserPromptWithRecovery } from "../../src/agent/user-prompt-runtime.js";
import { AgentRuntimeController } from "../../src/runtime/agent-runtime.js";

vi.mock("../../src/agent/user-prompt-runtime.js", () => ({
	runUserPromptWithRecovery: vi.fn(),
}));

vi.mock("../../src/agent/compaction-restoration.js", () => ({
	collectMcpMessagesForCompaction: vi.fn(() => []),
}));

vi.mock("../../src/mcp/index.js", () => ({
	mcpManager: {
		getStatus: vi.fn(() => ({ servers: [] })),
	},
}));

vi.mock("../../src/composers/index.js", () => ({
	composerManager: {
		getState: vi.fn(() => ({ active: false })),
		checkTriggers: vi.fn(() => null),
		activate: vi.fn(),
	},
}));

describe("AgentRuntimeController", () => {
	beforeEach(() => {
		vi.mocked(runUserPromptWithRecovery)
			.mockReset()
			.mockResolvedValue(undefined);
	});

	it("passes active skill restoration through the shared compaction path", async () => {
		const skillMessages = [
			{
				role: "hookMessage" as const,
				customType: "skill" as const,
				content: "Injected instructions for debug",
				display: false,
				details: { name: "debug", action: "activate" },
				timestamp: Date.now(),
			},
		];
		const renderer = {
			setInterruptCallback: vi.fn(),
			ensureContextBudgetBeforePrompt: vi.fn().mockResolvedValue(undefined),
			showInfo: vi.fn(),
			renderInitialMessages: vi.fn(),
			refreshFooterHint: vi.fn(),
			collectActiveSkillMessagesForCompaction: vi
				.fn()
				.mockReturnValue(skillMessages),
		} as never;
		const agent = {
			prompt: vi.fn().mockResolvedValue(undefined),
			emitStatus: vi.fn(),
			emitCompaction: vi.fn(),
			state: { messages: [] },
		} as never;
		const controller = new AgentRuntimeController({
			agent,
			sessionManager: {} as never,
			renderer,
		});

		controller.enqueue({ text: "hello" });

		await vi.waitFor(() =>
			expect(runUserPromptWithRecovery).toHaveBeenCalledTimes(1),
		);

		const params = vi.mocked(runUserPromptWithRecovery).mock.calls[0]?.[0];
		await expect(params?.getPostKeepMessages?.()).resolves.toEqual(
			skillMessages,
		);
		expect(params?.callbacks?.onCompacted).toBeTypeOf("function");

		params?.callbacks?.onCompacted?.({
			success: true,
			compactedCount: 3,
			summary: "Compacted",
			firstKeptEntryIndex: 4,
			tokensBefore: 1234,
		});

		expect(renderer.collectActiveSkillMessagesForCompaction).toHaveBeenCalled();
		expect(renderer.renderInitialMessages).toHaveBeenCalledTimes(1);
		expect(renderer.refreshFooterHint).toHaveBeenCalledTimes(1);
	});
});
