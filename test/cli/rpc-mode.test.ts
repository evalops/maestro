import { beforeEach, describe, expect, it, vi } from "vitest";
import { performCompaction } from "../../src/agent/compaction.js";
import { collectPersistedSessionStartHookMessages } from "../../src/agent/user-prompt-runtime.js";
import { runRpcMode } from "../../src/cli/rpc-mode.js";

let lineHandler: ((line: string) => void | Promise<void>) | undefined;

vi.mock("node:readline", () => ({
	createInterface: vi.fn(() => ({
		on: vi.fn((event: string, handler: (line: string) => unknown) => {
			if (event === "line") {
				lineHandler = handler as typeof lineHandler;
			}
		}),
	})),
}));

vi.mock("../../src/agent/compaction.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../src/agent/compaction.js")
	>("../../src/agent/compaction.js");
	return {
		...actual,
		performCompaction: vi.fn(),
	};
});

vi.mock("../../src/agent/user-prompt-runtime.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../src/agent/user-prompt-runtime.js")
	>("../../src/agent/user-prompt-runtime.js");
	return {
		...actual,
		collectPersistedSessionStartHookMessages: vi.fn(),
	};
});

describe("runRpcMode", () => {
	beforeEach(() => {
		lineHandler = undefined;
		vi.mocked(performCompaction).mockReset();
		vi.mocked(collectPersistedSessionStartHookMessages).mockReset();
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	it("passes compact SessionStart restoration messages into performCompaction", async () => {
		vi.mocked(performCompaction).mockResolvedValue({
			success: true,
			compactedCount: 2,
			summary: "Compacted 2 messages",
			firstKeptEntryIndex: 7,
			tokensBefore: 900,
		});
		vi.mocked(collectPersistedSessionStartHookMessages).mockResolvedValue([]);

		const agent = {
			state: { messages: [], isStreaming: false },
			subscribe: vi.fn(),
			abort: vi.fn(),
			continue: vi.fn(),
			prompt: vi.fn(),
			getQueuedMessageCount: vi.fn().mockReturnValue(0),
		};
		const sessionManager = {};

		void runRpcMode(agent as never, sessionManager as never);
		await vi.waitFor(() => expect(lineHandler).toBeTypeOf("function"));
		await lineHandler?.(JSON.stringify({ type: "compact" }));

		const params = vi.mocked(performCompaction).mock.calls[0]?.[0];
		await params?.getPostKeepMessages?.();
		expect(collectPersistedSessionStartHookMessages).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionManager,
				cwd: process.cwd(),
				source: "compact",
			}),
		);
	});
});
