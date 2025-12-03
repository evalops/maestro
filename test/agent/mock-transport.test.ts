import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Agent } from "../../src/agent/agent.js";
import type {
	AgentEvent,
	AgentRunConfig,
	AgentTransport,
	AppMessage,
	AssistantMessage,
	Message,
	Model,
	QueuedMessage,
	TextContent,
	ToolResultMessage,
} from "../../src/agent/types.js";
import { MockToolTransport } from "../../src/testing/mock-agent.js";
import { editTool } from "../../src/tools/edit.js";
import { readTool } from "../../src/tools/read.js";
import { writeTool } from "../../src/tools/write.js";

const mockModel: Model<"openai-completions"> = {
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

	it("transforms and injects queued messages", async () => {
		class QueueCaptureTransport implements AgentTransport {
			public queuedMessages: QueuedMessage<AppMessage>[] = [];

			async *run(
				_messages: Message[],
				userMessage: Message,
				config: AgentRunConfig,
			): AsyncGenerator<AgentEvent, void, unknown> {
				yield { type: "turn_start" };
				yield { type: "message_start", message: userMessage };
				yield { type: "message_end", message: userMessage };

				const queued = await config.getQueuedMessages?.<AppMessage>();
				this.queuedMessages = queued ?? [];
				for (const entry of this.queuedMessages) {
					yield { type: "message_start", message: entry.original };
					yield { type: "message_end", message: entry.original };
				}

				const assistant: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					api: "openai-completions",
					provider: "mock",
					model: "mock",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
					stopReason: "stop",
					timestamp: Date.now(),
				};
				yield { type: "message_start", message: assistant };
				yield { type: "message_end", message: assistant };
				yield { type: "turn_end", message: assistant, toolResults: [] };
			}
		}

		const transport = new QueueCaptureTransport();
		const agent = new Agent({
			transport,
			initialState: { model: mockModel },
		});

		await agent.queueMessage({
			role: "user",
			content: [{ type: "text", text: "See docs" }],
			attachments: [
				{
					id: "doc-1",
					type: "document",
					fileName: "design.md",
					mimeType: "text/markdown",
					size: 10,
					content: Buffer.from("Hello").toString("base64"),
					extractedText: "Important notes",
				},
			],
			timestamp: Date.now(),
		});

		await agent.prompt("Process queued context");

		expect(transport.queuedMessages).toHaveLength(1);
		const queuedEntry = transport.queuedMessages[0];
		expect(queuedEntry.original.role).toBe("user");
		const rawContent = queuedEntry.llm?.content;
		const llmContent = Array.isArray(rawContent) ? rawContent : [];
		const docBlock = llmContent.find(
			(chunk) => chunk.type === "text" && chunk.text.includes("[Document"),
		);
		expect(docBlock).toBeDefined();
	});
});
