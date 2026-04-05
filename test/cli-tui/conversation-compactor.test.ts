import { beforeEach, describe, expect, it, vi } from "vitest";
import { performCompaction } from "../../src/agent/compaction.js";
import { ConversationCompactor } from "../../src/cli-tui/session/conversation-compactor.js";

vi.mock("../../src/agent/compaction.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../src/agent/compaction.js")
	>("../../src/agent/compaction.js");
	return {
		...actual,
		performCompaction: vi.fn(),
	};
});

describe("ConversationCompactor", () => {
	beforeEach(() => {
		vi.mocked(performCompaction).mockReset();
	});

	it("reruns SessionStart hooks after a successful compaction", async () => {
		vi.mocked(performCompaction).mockResolvedValue({
			success: true,
			compactedCount: 3,
			summary: "Compacted 3 messages",
			firstKeptEntryIndex: 4,
			tokensBefore: 1234,
		});

		const runSessionStartHooks = vi.fn().mockResolvedValue(undefined);
		const renderMessages = vi.fn();
		const showInfoMessage = vi.fn();
		const compactor = new ConversationCompactor({
			agent: {} as never,
			sessionManager: {} as never,
			chatContainer: { clear: vi.fn() } as never,
			ui: {} as never,
			footer: { setHint: vi.fn() } as never,
			idleHint: "Idle",
			toolComponents: new Set(),
			renderMessages,
			showInfoMessage,
			runSessionStartHooks,
		});

		await compactor.compactHistory();

		expect(runSessionStartHooks).toHaveBeenCalledWith("compact");
		expect(runSessionStartHooks.mock.invocationCallOrder[0]).toBeLessThan(
			renderMessages.mock.invocationCallOrder[0],
		);
		expect(showInfoMessage).toHaveBeenCalledWith("Compacted 3 messages.");
	});
});
