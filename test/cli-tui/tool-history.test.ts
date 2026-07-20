import { describe, expect, it } from "vitest";
import { ToolHistoryStore } from "../../src/cli-tui/history/tool-history.js";

describe("ToolHistoryStore", () => {
	it("stores a concise summary derived from tool args", () => {
		const store = new ToolHistoryStore({ persistence: "none" });
		store.recordStart("call-1", "read", { file_path: "/tmp/config.json" });
		store.recordEnd(
			"call-1",
			"read",
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "file contents" }],
				isError: false,
				timestamp: Date.now(),
			},
			false,
		);

		const entry = store.recent(1)[0];
		expect(entry?.summary).toBe("Read config.json");
		expect(entry?.preview).toBe("file contents");
	});
});
