import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { Agent } from "../../src/agent/agent.js";
import type {
	AgentEvent,
	AgentRunConfig,
	AgentTool,
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

function createAssistantToolCallMessage(
	toolCallId: string,
	toolName: string,
	args: Record<string, unknown>,
): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: toolCallId,
				name: toolName,
				arguments: args,
			},
		],
		api: "openai-completions",
		provider: "mock",
		model: "mock-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function createAssistantTextMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "mock",
		model: "mock-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

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
		expect(
			events.find(
				(
					event,
				): event is Extract<AgentEvent, { type: "tool_execution_start" }> =>
					event.type === "tool_execution_start",
			),
		).toMatchObject({
			type: "tool_execution_start",
			toolName: "read",
			displayName: "Read",
			summaryLabel: "Read README.md",
		});
		expect(
			events.find(
				(event) =>
					event.type === "status" &&
					event.details.kind === "tool_execution_summary",
			),
		).toMatchObject({
			type: "status",
			status: "Reading README.md",
			details: {
				kind: "tool_execution_summary",
				toolName: "read",
			},
		});
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

	it("preserves specific live tool labels across generic updates", async () => {
		const events: AgentEvent[] = [];
		const descriptiveTool: AgentTool = {
			name: "custom_read",
			label: "Custom Read",
			description: "Read a specific resource",
			parameters: Type.Object({
				path: Type.Optional(Type.String()),
			}),
			getDisplayName: (params) =>
				typeof params.path === "string" ? `Read ${params.path}` : "Read file",
			getToolUseSummary: (params) =>
				typeof params.path === "string" ? `Read ${params.path}` : "Read file",
			execute: async () => ({
				content: [{ type: "text", text: "unused" }],
			}),
		};

		class SparseUpdateTransport implements AgentTransport {
			async *continue(): AsyncGenerator<AgentEvent, void, unknown> {}

			async *run(
				_messages: Message[],
				userMessage: Message,
				_config: AgentRunConfig,
			): AsyncGenerator<AgentEvent, void, unknown> {
				yield { type: "message_start", message: userMessage };
				yield { type: "message_end", message: userMessage };

				const toolCallId = "tool-call-1";
				const fullArgs = { path: "README.md" };
				yield {
					type: "message_start",
					message: createAssistantToolCallMessage(
						toolCallId,
						"custom_read",
						fullArgs,
					),
				};
				yield {
					type: "message_end",
					message: createAssistantToolCallMessage(
						toolCallId,
						"custom_read",
						fullArgs,
					),
				};
				yield {
					type: "tool_execution_start",
					toolCallId,
					toolName: "custom_read",
					args: fullArgs,
				};
				yield {
					type: "tool_execution_update",
					toolCallId,
					toolName: "custom_read",
					args: {},
					partialResult: {
						content: [{ type: "text", text: "partial" }],
					},
				};
				yield {
					type: "tool_execution_end",
					toolCallId,
					toolName: "custom_read",
					result: {
						role: "toolResult",
						toolCallId,
						toolName: "custom_read",
						content: [{ type: "text", text: "done" }],
						isError: false,
						timestamp: Date.now(),
					},
					isError: false,
				};
				const finalMessage = createAssistantTextMessage("Done");
				yield { type: "message_start", message: finalMessage };
				yield { type: "message_end", message: finalMessage };
			}
		}

		const agent = new Agent({
			transport: new SparseUpdateTransport(),
			initialState: { model: mockModel, tools: [descriptiveTool] },
		});

		agent.subscribe((event) => events.push(event));
		await agent.prompt("read file");

		const updateEvent = events.find(
			(
				event,
			): event is Extract<AgentEvent, { type: "tool_execution_update" }> =>
				event.type === "tool_execution_update",
		);
		const endEvent = events.find(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
				event.type === "tool_execution_end",
		);

		expect(updateEvent).toMatchObject({
			type: "tool_execution_update",
			displayName: "Read README.md",
			summaryLabel: "Read README.md",
		});
		expect(endEvent).toMatchObject({
			type: "tool_execution_end",
			displayName: "Read README.md",
			summaryLabel: "Read README.md",
		});
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

			async *continue(
				messages: Message[],
				config: AgentRunConfig,
			): AsyncGenerator<AgentEvent, void, unknown> {
				const msg: Message = {
					role: "user",
					content: [{ type: "text", text: "[continue]" }],
					timestamp: Date.now(),
				};
				yield* this.run(messages, msg, config);
			}

			async *run(
				_messages: Message[],
				userMessage: Message,
				config: AgentRunConfig,
			): AsyncGenerator<AgentEvent, void, unknown> {
				yield { type: "turn_start" };
				yield { type: "message_start", message: userMessage };
				yield { type: "message_end", message: userMessage };

				const queued = await config.getFollowUpMessages?.<AppMessage>();
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

		await agent.followUp({
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
		const queuedEntry = transport.queuedMessages[0]!;
		expect(queuedEntry.original.role).toBe("user");
		const rawContent = queuedEntry.llm?.content;
		const llmContent = Array.isArray(rawContent) ? rawContent : [];
		const docBlock = llmContent.find(
			(chunk) => chunk.type === "text" && chunk.text.includes("[Document"),
		);
		expect(docBlock).toBeDefined();
	});

	it("continue() delegates to run() with synthetic message", async () => {
		const events: AgentEvent[] = [];
		let receivedUserMessage: Message | null = null;

		class ContinueTrackingTransport implements AgentTransport {
			async *continue(
				messages: Message[],
				config: AgentRunConfig,
				signal?: AbortSignal,
			): AsyncGenerator<AgentEvent, void, unknown> {
				const continuationMessage: Message = {
					role: "user",
					content: [
						{
							type: "text",
							text: "[System: Continuing from previous context]",
						},
					],
					timestamp: Date.now(),
				};
				yield* this.run(messages, continuationMessage, config, signal);
			}

			async *run(
				_messages: Message[],
				userMessage: Message,
				_config: AgentRunConfig,
				_signal?: AbortSignal,
			): AsyncGenerator<AgentEvent, void, unknown> {
				receivedUserMessage = userMessage;
				yield { type: "turn_start" };
				yield { type: "message_start", message: userMessage };
				yield { type: "message_end", message: userMessage };

				const assistant: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "continued" }],
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

		const transport = new ContinueTrackingTransport();
		const config: AgentRunConfig = {
			model: mockModel,
			tools: [],
			systemPrompt: "test",
		};

		// Collect events from continue()
		for await (const event of transport.continue([], config)) {
			events.push(event);
		}

		// Verify continue() called run() with a synthetic message
		expect(receivedUserMessage).not.toBeNull();
		const msg = receivedUserMessage as unknown as Message;
		expect(msg.role).toBe("user");

		// Check that the synthetic message has continuation text
		const content = msg.content;
		expect(Array.isArray(content)).toBe(true);
		if (Array.isArray(content)) {
			const textContent = content.find(
				(c): c is TextContent => c.type === "text",
			);
			expect(textContent?.text).toContain("Continuing");
		}

		// Verify events were emitted
		expect(events.length).toBeGreaterThan(0);
		expect(events.some((e) => e.type === "turn_start")).toBe(true);
		expect(events.some((e) => e.type === "turn_end")).toBe(true);
	});

	it("continue() can append a provider-only continuation prompt", async () => {
		let receivedMessages: Message[] | null = null;
		let receivedUserMessage: Message | null = null;

		class ContinuationPromptTransport implements AgentTransport {
			async *continue(): AsyncGenerator<AgentEvent, void, unknown> {
				yield* (async function* empty(): AsyncGenerator<AgentEvent> {})();
			}

			async *run(
				messages: Message[],
				userMessage: Message,
				_config: AgentRunConfig,
			): AsyncGenerator<AgentEvent, void, unknown> {
				receivedMessages = messages;
				receivedUserMessage = userMessage;
				yield { type: "turn_start" };
				yield { type: "message_start", message: userMessage };

				const assistant: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "continued" }],
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

		const agent = new Agent({
			transport: new ContinuationPromptTransport(),
			initialState: {
				model: mockModel,
				tools: [],
				messages: [
					{ role: "user", content: "Need the rest", timestamp: 1 },
					{
						role: "assistant",
						content: [{ type: "text", text: "partial answer" }],
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
						stopReason: "length",
						timestamp: 2,
					},
				],
			},
		});

		await agent.continue({
			continuationPrompt:
				"Resume directly with the unfinished answer. No apology.",
		});

		expect(receivedMessages).not.toBeNull();
		expect(receivedMessages).toHaveLength(3);
		expect(receivedMessages?.at(-1)).toMatchObject({
			role: "user",
			content: "Resume directly with the unfinished answer. No apology.",
		});
		expect(receivedUserMessage).toMatchObject({
			role: "user",
			content: [],
		});
		expect(agent.state.messages).toHaveLength(3);
		expect(
			agent.state.messages.some(
				(message) =>
					message.role === "user" &&
					typeof message.content === "string" &&
					message.content.includes("Resume directly"),
			),
		).toBe(false);
	});

	it("continue() normalizes appended continuation prompts with trailing user turns", async () => {
		let receivedMessages: Message[] | null = null;

		class ContinuationPromptMergeTransport implements AgentTransport {
			async *continue(): AsyncGenerator<AgentEvent, void, unknown> {
				yield* (async function* empty(): AsyncGenerator<AgentEvent> {})();
			}

			async *run(
				messages: Message[],
				userMessage: Message,
				_config: AgentRunConfig,
			): AsyncGenerator<AgentEvent, void, unknown> {
				receivedMessages = messages;
				yield { type: "turn_start" };
				yield { type: "message_start", message: userMessage };

				const assistant: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "continued" }],
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

		const agent = new Agent({
			transport: new ContinuationPromptMergeTransport(),
			initialState: {
				model: mockModel,
				tools: [],
				messages: [
					{
						role: "user",
						content: "Queued SessionStart prompt",
						timestamp: 1,
					},
					{
						role: "user",
						content: "Queued follow-up prompt",
						timestamp: 2,
					},
				],
			},
		});

		await agent.continue({
			continuationPrompt: "Resume directly with the unfinished answer.",
		});

		expect(receivedMessages).not.toBeNull();
		expect(receivedMessages).toHaveLength(1);
		expect(receivedMessages?.[0]?.role).toBe("user");
		expect(receivedMessages?.[0]?.content).toMatchObject([
			{ type: "text", text: "Queued SessionStart prompt" },
			{ type: "text", text: "\n\n" },
			{ type: "text", text: "Queued follow-up prompt" },
			{ type: "text", text: "\n\n" },
			{ type: "text", text: "Resume directly with the unfinished answer." },
		]);
	});

	it("continue() can override max tokens for a single continuation", async () => {
		let receivedMaxTokens: number | null = null;

		class MaxTokensContinuationTransport implements AgentTransport {
			async *continue(): AsyncGenerator<AgentEvent, void, unknown> {
				yield* (async function* empty(): AsyncGenerator<AgentEvent> {})();
			}

			async *run(
				_messages: Message[],
				userMessage: Message,
				config: AgentRunConfig,
			): AsyncGenerator<AgentEvent, void, unknown> {
				receivedMaxTokens = config.model.maxTokens;
				yield { type: "turn_start" };
				yield { type: "message_start", message: userMessage };

				const assistant: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "continued" }],
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
			}
		}

		const agent = new Agent({
			transport: new MaxTokensContinuationTransport(),
			initialState: {
				model: mockModel,
				tools: [],
				messages: [
					{ role: "user", content: "Need the rest", timestamp: 1 },
					{
						role: "assistant",
						content: [{ type: "text", text: "partial answer" }],
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
						stopReason: "length",
						timestamp: 2,
					},
				],
			},
		});

		await agent.continue({ maxTokensOverride: 64_000 });

		expect(receivedMaxTokens).toBe(64_000);
		expect(agent.state.model.maxTokens).toBe(mockModel.maxTokens);
	});

	it("clears stale agent errors before a subsequent successful prompt", async () => {
		class FailThenSucceedTransport implements AgentTransport {
			private attempts = 0;

			async *continue(
				_messages: Message[],
				_config: AgentRunConfig,
			): AsyncGenerator<AgentEvent, void, unknown> {
				yield* (async function* empty(): AsyncGenerator<AgentEvent> {})();
				throw new Error("Not used in this test");
			}

			async *run(): AsyncGenerator<AgentEvent, void, unknown> {
				this.attempts += 1;
				if (this.attempts === 1) {
					throw new Error("first run failed");
				}

				const assistant: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "recovered" }],
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
			}
		}

		const agent = new Agent({
			transport: new FailThenSucceedTransport(),
			initialState: { model: mockModel },
		});

		await expect(agent.prompt("fail first")).rejects.toThrow(
			"first run failed",
		);
		expect(agent.state.error).toBe("first run failed");

		await agent.prompt("try again");

		expect(agent.state.error).toBeUndefined();
		const finalAssistant = [...agent.state.messages]
			.reverse()
			.find(
				(message): message is AssistantMessage => message.role === "assistant",
			);
		expect(finalAssistant?.content.find(isTextContent)?.text).toBe("recovered");
	});
});
