import { describe, expect, it } from "vitest";
import { BatchRenderer } from "../../src/tui/tool-renderers/render-batch.js";
import type { ToolRenderArgs } from "../../src/tui/tool-renderers/types.js";

const renderer = new BatchRenderer();

const baseArgs: ToolRenderArgs = {
	toolName: "batch",
	args: {},
	collapsed: false,
	result: {
		isError: false,
		details: {
			results: [
				{
					tool: "read",
					summary: "ok",
					success: true,
					details: { durationMs: 120 },
				},
				{
					tool: "write",
					summary: "wrote file",
					success: true,
					details: { durationMs: 240 },
				},
				{
					tool: "bash",
					summary: "failed to run",
					success: false,
					result: {
						isError: true,
						content: [{ type: "text", text: "exit 1" }],
					},
					details: { durationMs: 300 },
				},
			],
		},
		content: [{ type: "text", text: "Batch preview content" }],
	},
};

describe("BatchRenderer", () => {
	it("renders expanded batch with bar and durations", () => {
		const output = renderer.render(baseArgs);
		expect(output).toMatchSnapshot();
	});

	it("renders collapsed batch with error snippet", () => {
		const collapsed: ToolRenderArgs = { ...baseArgs, collapsed: true };
		const output = renderer.render(collapsed);
		expect(output).toMatchSnapshot();
	});
});
