import { describe, expect, it } from "vitest";
import {
	summarizeDesktopToolCall,
	summarizeDesktopToolCalls,
} from "../../packages/desktop/src/renderer/lib/tool-summary";

describe("desktop tool summaries", () => {
	it("summarizes common file and command tools", () => {
		expect(
			summarizeDesktopToolCall("read", { path: "/repo/src/index.ts" }),
		).toBe("Read index.ts");
		expect(
			summarizeDesktopToolCall("bash", {
				command: "bun run test -- --runInBand",
			}),
		).toBe("Ran bun run test -- --runInBand");
	});

	it("deduplicates repeated labels", () => {
		expect(
			summarizeDesktopToolCalls([
				{ id: "1", name: "read", args: { path: "src/app.ts" } },
				{ id: "2", name: "read", args: { path: "src/app.ts" } },
				{ id: "3", name: "search", args: { pattern: "handleChat" } },
			]),
		).toEqual(["Read app.ts", 'Searched for "handleChat"']);
	});
});
