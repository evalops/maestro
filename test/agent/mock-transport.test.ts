import { describe, expect, it } from "vitest";
import { Agent } from "../../src/agent/agent.js";
import type { AgentEvent } from "../../src/agent/types.js";
import { MockToolTransport } from "../../src/testing/mock-agent.js";
import { readTool } from "../../src/tools/read.js";

describe("Agent mock transport", () => {
	it("runs tool execution flow", async () => {
		const events: AgentEvent[] = [];
		const mockUserMessage: AppMessage = {
			role: "user",
			content: [{ type: "text", text: "Read file" }],
			timestamp: Date.now(),
		};

		const transport = new MockToolTransport(
			[
				{ name: "read", args: { path: "README.md" } },
			],
			() => "Done",
		);

		const agent = new Agent({
			transport,
			initialState: {
				model: {
					id: "mock",
					name: "Mock",
					provider: "mock",
					api: "openai-completions",
					baseUrl: "",
					reasoning: false,
					contextWindow: 8192,
					maxTokens: 2048,
				},
				tools: [readTool],
			}
		});

		agent.subscribe((event) => events.push(event));
		agent.setTools([readTool]);
		await agent.prompt("read file");

		const toolEvents = events.filter((event) =>
			event.type === "tool_execution_start" || event.type === "tool_execution_end",
		);
		expect(toolEvents.length).toBe(2);
		const finalEvent = [...events]
			.reverse()
			.find((event) =>
				event.type === "message_start" &&
				event.message.role === "assistant" &&
				event.message.content.some((c) => c.type === "text"),
			);
		expect(finalEvent && finalEvent.message.content.find((c) => c.type === "text")?.text).toBe("Done");
	});
});
