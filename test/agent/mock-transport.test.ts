import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Agent } from "../../src/agent/agent.js";
import type {
	AgentEvent,
	AssistantMessage,
	Model,
	TextContent,
	ToolResultMessage,
} from "../../src/agent/types.js";
import { MockToolTransport } from "../../src/testing/mock-agent.js";
import { editTool } from "../../src/tools/edit.js";
import { readTool } from "../../src/tools/read.js";
import { writeTool } from "../../src/tools/write.js";

const mockModel: Model<any> = {
	id: "mock",
	name: "Mock",
	provider: "mock",
	api: "openai-completions",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	},
	contextWindow: 8192,
	maxTokens: 2048,
};

const isTextContent = (
	chunk:
		| AssistantMessage["content"][number]
		| ToolResultMessage["content"][number],
): chunk is TextContent => chunk.type === "text";

const isAssistantMessageStart = (
	event: AgentEvent,
): event is Extract<AgentEvent, { type: "message_start" }> & {
	message: AssistantMessage;
} => event.type === "message_start" && event.message.role === "assistant";

describe("Agent mock transport", () => {
	it("runs tool execution flow", async () => {
		const events: AgentEvent[] = [];

		const transport = new MockToolTransport(
			[{ name: "read", args: { path: "README.md" } }],
			() => "Done",
		);

		const agent = new Agent({
			transport,
			initialState: { model: mockModel, tools: [readTool] },
		});

		agent.subscribe((event) => events.push(event));
		agent.setTools([readTool]);
		await agent.prompt("read file");

		const toolEvents = events.filter(
			(event) =>
				event.type === "tool_execution_start" ||
				event.type === "tool_execution_end",
		);
		expect(toolEvents.length).toBe(2);
		const finalEvent = [...events].reverse().find(
			(
				event,
			): event is Extract<AgentEvent, { type: "message_start" }> & {
				message: AssistantMessage;
			} =>
				isAssistantMessageStart(event) &&
				event.message.content.some(isTextContent),
		);
		expect(finalEvent?.message.content.find(isTextContent)?.text).toBe("Done");
	});

	it("handles multi-tool sequences", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "agent-mock-"));
		const filePath = join(tempDir, "note.txt");
		let summary = "";
		const transport = new MockToolTransport(
			[
				{ name: "write", args: { path: filePath, content: "Original" } },
				{
					name: "edit",
					args: { path: filePath, oldText: "Original", newText: "Updated" },
				},
				{
					name: "read",
					args: { path: filePath },
					onResult: (result) => {
						const text = result.content.find((item) => item.type === "text");
						summary = text?.text?.split("\n").find((line) => line.trim()) ?? "";
					},
				},
			],
			() => `Summary: ${summary.trim()}`,
		);

		const agent = new Agent({
			transport,
			initialState: {
				model: mockModel,
				tools: [writeTool, editTool, readTool],
			},
		});
		agent.setTools([writeTool, editTool, readTool]);
		await agent.prompt("Update note");

		const finalAssistant = [...agent.state.messages]
			.reverse()
			.find(
				(message): message is AssistantMessage =>
					message.role === "assistant" && message.content.some(isTextContent),
			);
		expect(finalAssistant?.content.find(isTextContent)?.text).toBe(
			`Summary: ${summary.trim()}`,
		);

		rmSync(tempDir, { recursive: true, force: true });
	});

	it("propagates tool errors and continues", async () => {
		const events: AgentEvent[] = [];
		const transport = new MockToolTransport(
			[
				{ name: "read", args: { path: "README.md" }, error: "boom" },
				{ name: "read", args: { path: "README.md" } },
			],
			() => "Done",
		);

		const agent = new Agent({
			transport,
			initialState: { model: mockModel, tools: [readTool] },
		});

		agent.subscribe((event) => events.push(event));
		await agent.prompt("read file");

		const errorEvents = events.filter(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
				event.type === "tool_execution_end" && event.isError,
		);
		expect(errorEvents.length).toBe(1);
		const finalAssistant = [...agent.state.messages]
			.reverse()
			.find(
				(message): message is AssistantMessage => message.role === "assistant",
			);
		expect(finalAssistant?.content.find(isTextContent)?.text).toBe("Done");
	});

	it("aborts execution when agent abort is called", async () => {
		const transport = new MockToolTransport(
			[{ name: "read", args: { path: "README.md" } }],
			() => "Done",
		);

		const agent = new Agent({
			transport,
			initialState: { model: mockModel, tools: [readTool] },
		});

		const runPromise = agent.prompt("read file");
		agent.abort();
		await expect(runPromise).resolves.toBeUndefined();
	});
});
