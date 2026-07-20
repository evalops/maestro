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

	it("passes compact restoration messages into performCompaction before rerender", async () => {
		vi.mocked(performCompaction).mockResolvedValue({
			success: true,
			compactedCount: 3,
			summary: "Compacted 3 messages",
			firstKeptEntryIndex: 4,
			tokensBefore: 1234,
		});

		const getPostKeepMessages = vi.fn().mockResolvedValue([]);
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
			getPostKeepMessages,
		});

		await compactor.compactHistory();

		const params = vi.mocked(performCompaction).mock.calls[0]?.[0];
		await params?.getPostKeepMessages?.([]);
		expect(getPostKeepMessages).toHaveBeenCalledWith("compact", []);
		expect(showInfoMessage).toHaveBeenCalledWith("Compacted 3 messages.");
	});
});
