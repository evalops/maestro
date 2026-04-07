import { describe, expect, it } from "vitest";
import {
	buildLiveToolStartPayload,
	summarizeVscodeToolCall,
	withToolSummaryLabels,
} from "./tool-summary.js";

describe("vscode tool summary", () => {
	it("summarizes file tools with leaf paths", () => {
		expect(
			summarizeVscodeToolCall("read", {
				file_path: "/tmp/projects/maestro/package.json",
			}),
		).toBe("Read package.json");
	});

	it("summarizes command tools with the command text", () => {
		expect(
			summarizeVscodeToolCall("exec_command", {
				command: "bun run bun:lint",
			}),
		).toBe("Ran bun run bun:lint");
	});

	it("adds summary labels to message tools", () => {
		const message = withToolSummaryLabels({
			role: "assistant",
			content: "Done",
			timestamp: new Date(0).toISOString(),
			tools: [
				{
					name: "read",
					status: "completed",
					args: { file_path: "/workspace/src/index.ts" },
				},
			],
		});

		expect(message.tools?.[0]?.summaryLabel).toBe("Read index.ts");
	});

	it("preserves raw tool names in live tool payloads", () => {
		expect(
			buildLiveToolStartPayload(
				"read",
				{ path: "/workspace/README.md" },
				{ displayName: "Read File" },
			),
		).toEqual({
			name: "read",
			displayName: "Read File",
			summaryLabel: "Read README.md",
			args: { path: "/workspace/README.md" },
		});
	});
});
