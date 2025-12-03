// Force deterministic output (no ANSI) in CI snapshots
process.env.FORCE_COLOR = "0";

import { describe, expect, it } from "vitest";
import type { ToolRenderArgs } from "../../src/tui/tool-renderers/types.js";

// Force truecolor mode for consistent snapshots across environments
// Must be set before importing theme-dependent modules
process.env.COLORTERM = "truecolor";

// Import after setting COLORTERM
const { BatchRenderer } = await import(
	"../../src/tui/tool-renderers/render-batch.js"
);

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
