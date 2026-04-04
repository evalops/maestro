import { describe, expect, it } from "vitest";
import { Agent } from "../../src/agent/agent.js";
import type {
	AgentEvent,
	AgentRunConfig,
	AgentTransport,
	AssistantMessage,
	Message,
	Model,
	ToolResultMessage,
} from "../../src/agent/types.js";

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

describe("tool batch summary events", () => {
	it("emits a transient summary after the last tool in a batch finishes", async () => {
		const events: AgentEvent[] = [];

		class BatchedToolTransport implements AgentTransport {
			async *continue(
				messages: Message[],
				config: AgentRunConfig,
			): AsyncGenerator<AgentEvent, void, unknown> {
				const continuationMessage: Message = {
					role: "user",
					content: [{ type: "text", text: "[continue]" }],
					timestamp: Date.now(),
				};
				yield* this.run(messages, continuationMessage, config);
			}

			async *run(
				_messages: Message[],
				userMessage: Message,
			): AsyncGenerator<AgentEvent, void, unknown> {
				yield { type: "message_start", message: userMessage };
				yield { type: "message_end", message: userMessage };

				const toolBatchMessage: AssistantMessage = {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "tool_0",
							name: "read",
							arguments: { path: "README.md" },
						},
						{
							type: "toolCall",
							id: "tool_1",
							name: "write",
							arguments: { path: "notes.txt", content: "done" },
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
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
					stopReason: "toolUse",
					timestamp: Date.now(),
				};
				yield { type: "message_start", message: toolBatchMessage };
				yield { type: "message_end", message: toolBatchMessage };

				const readResult: ToolResultMessage = {
					role: "toolResult",
					toolCallId: "tool_0",
					toolName: "read",
					content: [{ type: "text", text: "README contents" }],
					isError: false,
					timestamp: Date.now(),
				};
				yield {
					type: "tool_execution_start",
					toolCallId: "tool_0",
					toolName: "read",
					args: { path: "README.md" },
				};
				yield {
					type: "tool_execution_end",
					toolCallId: "tool_0",
					toolName: "read",
					result: readResult,
					isError: false,
				};

				const writeResult: ToolResultMessage = {
					role: "toolResult",
					toolCallId: "tool_1",
					toolName: "write",
					content: [{ type: "text", text: "Wrote notes.txt" }],
					isError: false,
					timestamp: Date.now(),
				};
				yield {
					type: "tool_execution_start",
					toolCallId: "tool_1",
					toolName: "write",
					args: { path: "notes.txt", content: "done" },
				};
				yield {
					type: "tool_execution_end",
					toolCallId: "tool_1",
					toolName: "write",
					result: writeResult,
					isError: false,
				};

				const finalAssistant: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "Done" }],
					api: "openai-completions",
					provider: "mock",
					model: "mock-model",
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
				yield { type: "message_start", message: finalAssistant };
				yield { type: "message_end", message: finalAssistant };
			}
		}

		const transport = new BatchedToolTransport();
		const agent = new Agent({
			transport,
			initialState: { model: mockModel, tools: [] },
		});

		agent.subscribe((event) => events.push(event));
		await agent.prompt("inspect and write");

		const summaryEvents = events.filter(
			(event): event is Extract<AgentEvent, { type: "tool_batch_summary" }> =>
				event.type === "tool_batch_summary",
		);
		expect(summaryEvents).toHaveLength(1);
		expect(summaryEvents[0]).toMatchObject({
			summary: "Read README.md, Wrote notes.txt",
			summaryLabels: ["Read README.md", "Wrote notes.txt"],
			toolCallIds: ["tool_0", "tool_1"],
			toolNames: ["read", "write"],
			callsSucceeded: 2,
			callsFailed: 0,
		});

		const summaryIndex = events.findIndex(
			(event) => event.type === "tool_batch_summary",
		);
		const lastToolIndex = events.findLastIndex(
			(event) => event.type === "tool_execution_end",
		);
		const assistantIndex = events.findIndex(
			(event) =>
				event.type === "message_start" &&
				event.message.role === "assistant" &&
				event.message.content.some((block) => block.type === "text"),
		);
		expect(summaryIndex).toBeGreaterThan(lastToolIndex);
		expect(summaryIndex).toBeLessThan(assistantIndex);
		expect(
			agent.state.messages.some(
				(message) =>
					message.role === "hookMessage" ||
					(message.role === "assistant" &&
						message.content.some(
							(block) =>
								block.type === "text" &&
								block.text.includes("Read README.md, Wrote notes.txt"),
						)),
			),
		).toBe(false);
	});

	it("clears batch tracking state in transient and full resets", () => {
		const transport: AgentTransport = {
			async *run(): AsyncGenerator<AgentEvent, void, unknown> {},
			async *continue(): AsyncGenerator<AgentEvent, void, unknown> {},
		};
		const agent = new Agent({
			transport,
			initialState: { model: mockModel, tools: [] },
		});
		const internalAgent = agent as unknown as {
			activeToolBatchIds: Set<string> | null;
			completedToolBatch: Array<{
				toolCallId: string;
				toolName: string;
				args: Record<string, unknown>;
				isError: boolean;
			}>;
		};

		internalAgent.activeToolBatchIds = new Set(["tool_0"]);
		internalAgent.completedToolBatch = [
			{
				toolCallId: "tool_0",
				toolName: "read",
				args: { path: "README.md" },
				isError: false,
			},
		];
		agent.clearTransientRunState();
		expect(internalAgent.activeToolBatchIds).toBeNull();
		expect(internalAgent.completedToolBatch).toEqual([]);

		internalAgent.activeToolBatchIds = new Set(["tool_1"]);
		internalAgent.completedToolBatch = [
			{
				toolCallId: "tool_1",
				toolName: "write",
				args: { path: "notes.txt" },
				isError: false,
			},
		];
		agent.reset();
		expect(internalAgent.activeToolBatchIds).toBeNull();
		expect(internalAgent.completedToolBatch).toEqual([]);
	});
});
