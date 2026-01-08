import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import type { AgentTool, ToolCall } from "../../src/agent/types.js";

describe("validateToolArguments CSP fallback", () => {
	it("drops invalid args when running under CSP constraints", async () => {
		vi.resetModules();
		vi.stubGlobal("chrome", { runtime: { id: "test-extension" } });

		const { validateToolArguments } = await import(
			"../../src/agent/providers/validation.js"
		);

		const tool: AgentTool = {
			name: "demo",
			description: "demo tool",
			parameters: Type.Object({ value: Type.Number() }),
			execute: async () => ({ content: [] }),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call_1",
			name: "demo",
			arguments: { value: "oops" },
		};

		const validated = validateToolArguments(tool, toolCall);
		expect(validated).toEqual({});

		vi.unstubAllGlobals();
	});
});
