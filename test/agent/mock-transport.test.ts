import { describe, expect, it } from "vitest";
import { Agent } from "../../src/agent/agent.js";
import type {
	AgentEvent,
	AgentRunConfig,
	AgentTransport,
	AppMessage,
	Message,
	ToolResultMessage,
} from "../../src/agent/types.js";
import { readTool } from "../../dist/tools/read.js";

describe("Agent mock transport", () => {
	it("runs tool execution flow", async () => {
		const events: AgentEvent[] = [];
		const mockUserMessage: AppMessage = {
			role: "user",
			content: [{ type: "text", text: "Read file" }],
			timestamp: Date.now(),
		};

		class MockTransport implements AgentTransport {
			async *run(
				messages: Message[],
				userMessage: Message,
				config: AgentRunConfig,
				signal?: AbortSignal,
			): AsyncGenerator<AgentEvent, void, unknown> {
				yield { type: "message_start", message: userMessage };
				const toolCallId = "mock-call";
				yield {
					type: "message_start",
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: toolCallId,
								name: "read",
								arguments: { path: "README.md" },
							},
						],
						api: "mock",
						provider: "mock",
						model: "mock",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse",
						timestamp: Date.now(),
					},
				};

				const tool = config.tools.find((t) => t.name === "read");
				if (!tool) throw new Error("Missing read tool");
				yield {
					type: "tool_execution_start",
					toolCallId,
					toolName: "read",
					args: { path: "README.md" },
				};

				const result = await tool.execute(toolCallId, { path: "README.md" }, signal);
				const toolResultMessage: ToolResultMessage = {
					role: "toolResult",
					toolCallId,
					toolName: "read",
					content: result.content,
					details: result.details,
					isError: result.isError ?? false,
					timestamp: Date.now(),
				};

				yield {
					type: "tool_execution_end",
					toolCallId,
					oolName: "read",
					result: toolResultMessage,
					isError: false,
				};

				yield {
					type: "message_start",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Done" }],
						api: "mock",
						provider: "mock",
						model: "mock",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					},
				};
			}
		}

		const agent = new Agent({
			transport: new MockTransport(),
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
