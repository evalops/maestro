import { beforeEach, describe, expect, it, vi } from "vitest";
import { performCompaction } from "../../src/agent/compaction.js";
import { applySessionStartHooks } from "../../src/agent/user-prompt-runtime.js";
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
		applySessionStartHooks: vi.fn(),
	};
});

describe("runRpcMode", () => {
	beforeEach(() => {
		lineHandler = undefined;
		vi.mocked(performCompaction).mockReset();
		vi.mocked(applySessionStartHooks).mockReset();
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	it("reruns SessionStart hooks after successful manual compaction", async () => {
		vi.mocked(performCompaction).mockResolvedValue({
			success: true,
			compactedCount: 2,
			summary: "Compacted 2 messages",
			firstKeptEntryIndex: 7,
			tokensBefore: 900,
		});
		vi.mocked(applySessionStartHooks).mockResolvedValue(undefined);

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

		expect(applySessionStartHooks).toHaveBeenCalledWith(
			expect.objectContaining({
				agent,
				sessionManager,
				cwd: process.cwd(),
				source: "compact",
			}),
		);
	});
});
