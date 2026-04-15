/**
 * Tests for the workflow tool.
 */

import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import type { AgentTool } from "../../packages/slack-agent/src/tools/index.js";
import { createWorkflowTool } from "../../packages/slack-agent/src/tools/workflow.js";

function createMockTool(
	name: string,
	resultText: string,
	details?: unknown,
): AgentTool {
	return {
		name,
		label: name,
		description: `Mock ${name}`,
		parameters: Type.Object({
			label: Type.String(),
		}),
		execute: async () => ({
			content: [{ type: "text", text: resultText }],
			details,
		}),
	};
}

describe("workflow tool", () => {
	it("has correct metadata", () => {
		const tool = createWorkflowTool([]);
		expect(tool.name).toBe("workflow");
		expect(tool.description).toContain("multi-step");
	});

	it("executes single-step workflow", async () => {
		const mockTool = createMockTool("echo", "hello world");
		const workflow = createWorkflowTool([mockTool]);

		const result = await workflow.execute("wf-1", {
			label: "test",
			steps: [{ name: "step1", tool: "echo", args: { label: "test" } }],
		});

		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("step1");
		expect(text).toContain("OK");
		expect(text).toContain("Workflow complete");
	});

	it("executes multi-step workflow", async () => {
		const tool1 = createMockTool("fetch", "data from API", {
			items: [1, 2, 3],
		});
		const tool2 = createMockTool("process", "processed data");
		const workflow = createWorkflowTool([tool1, tool2]);

		const result = await workflow.execute("wf-2", {
			label: "test",
			steps: [
				{ name: "fetch", tool: "fetch", args: { label: "step 1" } },
				{
					name: "process",
					tool: "process",
					args: { label: "step 2", data: "$steps.fetch" },
				},
			],
		});

		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Step 1/2");
		expect(text).toContain("Step 2/2");
		expect(text).toContain("Workflow complete");
	});

	it("fails on unknown tool", async () => {
		const workflow = createWorkflowTool([]);

		const result = await workflow.execute("wf-3", {
			label: "test",
			steps: [{ name: "step1", tool: "nonexistent", args: { label: "t" } }],
		});

		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("FAILED");
		expect(text).toContain("not found");
	});

	it("resolves $steps references", async () => {
		let receivedArgs: Record<string, unknown> = {};
		const tool1 = createMockTool("source", "source data", { key: "value" });
		const tool2: AgentTool = {
			name: "sink",
			label: "sink",
			description: "test",
			parameters: Type.Object({ label: Type.String() }),
			execute: async (_id, args) => {
				receivedArgs = args;
				return { content: [{ type: "text", text: "done" }] };
			},
		};

		const workflow = createWorkflowTool([tool1, tool2]);

		await workflow.execute("wf-4", {
			label: "test",
			steps: [
				{ name: "s1", tool: "source", args: { label: "get" } },
				{
					name: "s2",
					tool: "sink",
					args: { label: "process", input: "$steps.s1" },
				},
			],
		});

		expect(receivedArgs.input).toEqual({ key: "value" });
	});

	it("handles errors in steps gracefully", async () => {
		const failTool: AgentTool = {
			name: "fail",
			label: "fail",
			description: "test",
			parameters: Type.Object({ label: Type.String() }),
			execute: async () => {
				throw new Error("Step exploded");
			},
		};

		const workflow = createWorkflowTool([failTool]);

		const result = await workflow.execute("wf-5", {
			label: "test",
			steps: [{ name: "s1", tool: "fail", args: { label: "boom" } }],
		});

		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("ERROR");
		expect(text).toContain("Step exploded");
		expect(text).toContain("Workflow complete");
	});
});
