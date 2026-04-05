import { beforeEach, describe, expect, it, vi } from "vitest";
import { runUserPromptWithRecovery } from "../../src/agent/user-prompt-runtime.js";
import { AgentRuntimeController } from "../../src/runtime/agent-runtime.js";

vi.mock("../../src/agent/user-prompt-runtime.js", () => ({
	runUserPromptWithRecovery: vi.fn(),
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

	it("restores active skills before rerendering after auto-compaction", async () => {
		const renderer = {
			setInterruptCallback: vi.fn(),
			ensureContextBudgetBeforePrompt: vi.fn().mockResolvedValue(undefined),
			showInfo: vi.fn(),
			renderInitialMessages: vi.fn(),
			refreshFooterHint: vi.fn(),
			restoreActiveSkillsAfterCompaction: vi.fn(),
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
		expect(params?.callbacks?.onCompacted).toBeTypeOf("function");

		params?.callbacks?.onCompacted?.({
			success: true,
			compactedCount: 3,
			summary: "Compacted",
			firstKeptEntryIndex: 4,
			tokensBefore: 1234,
		});

		expect(renderer.restoreActiveSkillsAfterCompaction).toHaveBeenCalledTimes(
			1,
		);
		expect(
			renderer.restoreActiveSkillsAfterCompaction.mock.invocationCallOrder[0],
		).toBeLessThan(renderer.renderInitialMessages.mock.invocationCallOrder[0]);
	});
});
