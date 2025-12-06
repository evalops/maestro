import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context, Model } from "../../../src/agent/types.js";

// Mock the AWS SDK
const mockSend = vi.fn();
vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	return {
		BedrockRuntimeClient: vi.fn().mockImplementation(() => ({
			send: mockSend,
		})),
		ConverseStreamCommand: vi.fn().mockImplementation((input) => ({
			input,
		})),
	};
});

// Mock aws-auth module
vi.mock("../../../src/providers/aws-auth.js", () => ({
	getAwsRegion: vi.fn(() => "us-east-1"),
	hasAwsCredentials: vi.fn(() => true),
	buildBedrockUrl: vi.fn(
		(region: string, modelId: string, streaming: boolean) =>
			`https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/${streaming ? "converse-stream" : "converse"}`,
	),
}));

// Import after mocking
import { streamBedrock } from "../../../src/agent/providers/bedrock.js";

describe("Bedrock Provider", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
		process.env.AWS_ACCESS_KEY_ID = "test-access-key-id";
		process.env.AWS_SECRET_ACCESS_KEY = "test-secret-access-key";
		vi.clearAllMocks();
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	const createModel = (
		overrides: Partial<Model<"bedrock-converse">> = {},
	): Model<"bedrock-converse"> => ({
		id: "anthropic.claude-3-5-sonnet-20241022-v2:0",
		name: "Claude 3.5 Sonnet v2 (Bedrock)",
		api: "bedrock-converse",
		provider: "bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: false,
		toolUse: true,
		input: ["text", "image"],
		cost: {
			input: 3.0,
			output: 15.0,
			cacheRead: 0.3,
			cacheWrite: 3.75,
		},
		contextWindow: 200000,
		maxTokens: 8192,
		...overrides,
	});

	const createContext = (overrides: Partial<Context> = {}): Context => ({
		systemPrompt: "You are a helpful assistant.",
		messages: [
			{
				role: "user",
				content: "Hello, how are you?",
				timestamp: Date.now(),
			},
		],
		tools: [],
		...overrides,
	});

	// Helper to create async iterable from events
	function createMockStream(
		events: Array<Record<string, unknown>>,
	): AsyncIterable<Record<string, unknown>> {
		return {
			async *[Symbol.asyncIterator]() {
				for (const event of events) {
					yield event;
				}
			},
		};
	}

	describe("Message Conversion", () => {
		it("converts user text messages correctly", async () => {
			mockSend.mockResolvedValue({
				stream: createMockStream([
					{ messageStart: { role: "assistant" } },
					{ contentBlockStart: { contentBlockIndex: 0 } },
					{
						contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hi!" } },
					},
					{ contentBlockStop: { contentBlockIndex: 0 } },
					{ messageStop: { stopReason: "end_turn" } },
					{ metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
				]),
			});

			const model = createModel();
			const context = createContext({
				messages: [
					{ role: "user", content: "Hello world", timestamp: Date.now() },
				],
			});

			const events = [];
			for await (const event of streamBedrock(model, context, {})) {
				events.push(event);
			}

			// Check that the command was called with correct messages
			const { ConverseStreamCommand } = await import(
				"@aws-sdk/client-bedrock-runtime"
			);
			expect(ConverseStreamCommand).toHaveBeenCalledWith(
				expect.objectContaining({
					messages: [{ role: "user", content: [{ text: "Hello world" }] }],
				}),
			);
		});

		it("converts assistant messages with tool calls correctly", async () => {
			mockSend.mockResolvedValue({
				stream: createMockStream([
					{ messageStart: { role: "assistant" } },
					{ messageStop: { stopReason: "end_turn" } },
					{ metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
				]),
			});

			const model = createModel();
			const context = createContext({
				messages: [
					{ role: "user", content: "Read the file", timestamp: Date.now() },
					{
						role: "assistant",
						content: [
							{ type: "text", text: "I'll read that file for you." },
							{
								type: "toolCall",
								id: "tool-123",
								name: "read_file",
								arguments: { path: "/test.txt" },
							},
						],
						api: "bedrock-converse",
						provider: "bedrock",
						model: "test",
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
					},
				],
			});

			for await (const _ of streamBedrock(model, context, {})) {
				// consume events
			}

			const { ConverseStreamCommand } = await import(
				"@aws-sdk/client-bedrock-runtime"
			);
			expect(ConverseStreamCommand).toHaveBeenCalledWith(
				expect.objectContaining({
					messages: expect.arrayContaining([
						expect.objectContaining({
							role: "assistant",
							content: expect.arrayContaining([
								{ text: "I'll read that file for you." },
								{
									toolUse: {
										toolUseId: "tool-123",
										name: "read_file",
										input: { path: "/test.txt" },
									},
								},
							]),
						}),
					]),
				}),
			);
		});

		it("converts tool result messages correctly", async () => {
			mockSend.mockResolvedValue({
				stream: createMockStream([
					{ messageStart: { role: "assistant" } },
					{ messageStop: { stopReason: "end_turn" } },
					{ metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
				]),
			});

			const model = createModel();
			const context = createContext({
				messages: [
					{ role: "user", content: "Read the file", timestamp: Date.now() },
					{
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "tool-123",
								name: "read_file",
								arguments: { path: "/test.txt" },
							},
						],
						api: "bedrock-converse",
						provider: "bedrock",
						model: "test",
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
					},
					{
						role: "toolResult",
						toolCallId: "tool-123",
						toolName: "read_file",
						content: [{ type: "text", text: "File contents here" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			});

			for await (const _ of streamBedrock(model, context, {})) {
				// consume events
			}

			const { ConverseStreamCommand } = await import(
				"@aws-sdk/client-bedrock-runtime"
			);
			expect(ConverseStreamCommand).toHaveBeenCalledWith(
				expect.objectContaining({
					messages: expect.arrayContaining([
						expect.objectContaining({
							role: "user",
							content: expect.arrayContaining([
								expect.objectContaining({
									toolResult: {
										toolUseId: "tool-123",
										content: [{ text: "File contents here" }],
										status: "success",
									},
								}),
							]),
						}),
					]),
				}),
			);
		});

		it("marks error tool results correctly", async () => {
			mockSend.mockResolvedValue({
				stream: createMockStream([
					{ messageStart: { role: "assistant" } },
					{ messageStop: { stopReason: "end_turn" } },
					{ metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
				]),
			});

			const model = createModel();
			const context = createContext({
				messages: [
					{ role: "user", content: "Read the file", timestamp: Date.now() },
					{
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "tool-123",
								name: "read_file",
								arguments: { path: "/test.txt" },
							},
						],
						api: "bedrock-converse",
						provider: "bedrock",
						model: "test",
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
					},
					{
						role: "toolResult",
						toolCallId: "tool-123",
						toolName: "read_file",
						content: [{ type: "text", text: "File not found" }],
						isError: true,
						timestamp: Date.now(),
					},
				],
			});

			for await (const _ of streamBedrock(model, context, {})) {
				// consume events
			}

			const { ConverseStreamCommand } = await import(
				"@aws-sdk/client-bedrock-runtime"
			);
			expect(ConverseStreamCommand).toHaveBeenCalledWith(
				expect.objectContaining({
					messages: expect.arrayContaining([
						expect.objectContaining({
							content: expect.arrayContaining([
								expect.objectContaining({
									toolResult: expect.objectContaining({
										status: "error",
									}),
								}),
							]),
						}),
					]),
				}),
			);
		});
	});

	describe("Request Configuration", () => {
		it("includes system prompt when provided", async () => {
			mockSend.mockResolvedValue({
				stream: createMockStream([
					{ messageStart: { role: "assistant" } },
					{ messageStop: { stopReason: "end_turn" } },
					{ metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
				]),
			});

			const model = createModel();
			const context = createContext({
				systemPrompt: "You are a coding assistant.",
			});

			for await (const _ of streamBedrock(model, context, {})) {
				// consume events
			}

			const { ConverseStreamCommand } = await import(
				"@aws-sdk/client-bedrock-runtime"
			);
			expect(ConverseStreamCommand).toHaveBeenCalledWith(
				expect.objectContaining({
					system: [{ text: "You are a coding assistant." }],
				}),
			);
		});

		it("includes inference config with maxTokens", async () => {
			mockSend.mockResolvedValue({
				stream: createMockStream([
					{ messageStart: { role: "assistant" } },
					{ messageStop: { stopReason: "end_turn" } },
					{ metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
				]),
			});

			const model = createModel({ maxTokens: 4096 });
			const context = createContext();

			for await (const _ of streamBedrock(model, context, {
				maxTokens: 2048,
			})) {
				// consume events
			}

			const { ConverseStreamCommand } = await import(
				"@aws-sdk/client-bedrock-runtime"
			);
			expect(ConverseStreamCommand).toHaveBeenCalledWith(
				expect.objectContaining({
					inferenceConfig: expect.objectContaining({ maxTokens: 2048 }),
				}),
			);
		});

		it("includes temperature when specified", async () => {
			mockSend.mockResolvedValue({
				stream: createMockStream([
					{ messageStart: { role: "assistant" } },
					{ messageStop: { stopReason: "end_turn" } },
					{ metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
				]),
			});

			const model = createModel();
			const context = createContext();

			for await (const _ of streamBedrock(model, context, {
				temperature: 0.7,
			})) {
				// consume events
			}

			const { ConverseStreamCommand } = await import(
				"@aws-sdk/client-bedrock-runtime"
			);
			expect(ConverseStreamCommand).toHaveBeenCalledWith(
				expect.objectContaining({
					inferenceConfig: expect.objectContaining({ temperature: 0.7 }),
				}),
			);
		});

		it("includes tool config when tools are provided", async () => {
			mockSend.mockResolvedValue({
				stream: createMockStream([
					{ messageStart: { role: "assistant" } },
					{ messageStop: { stopReason: "end_turn" } },
					{ metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
				]),
			});

			const model = createModel();
			const context = createContext({
				tools: [
					{
						name: "read_file",
						description: "Reads a file from disk",
						parameters: {
							type: "object",
							properties: {
								path: { type: "string", description: "The file path" },
							},
							required: ["path"],
						},
						execute: async () => ({ content: [], isError: false }),
					},
				],
			});

			for await (const _ of streamBedrock(model, context, {})) {
				// consume events
			}

			const { ConverseStreamCommand } = await import(
				"@aws-sdk/client-bedrock-runtime"
			);
			expect(ConverseStreamCommand).toHaveBeenCalledWith(
				expect.objectContaining({
					toolConfig: {
						tools: [
							{
								toolSpec: {
									name: "read_file",
									description: "Reads a file from disk",
									inputSchema: {
										json: {
											type: "object",
											properties: {
												path: { type: "string", description: "The file path" },
											},
											required: ["path"],
										},
									},
								},
							},
						],
					},
				}),
			);
		});
	});

	describe("Streaming Events", () => {
		it("yields start event at beginning", async () => {
			mockSend.mockResolvedValue({
				stream: createMockStream([
					{ messageStart: { role: "assistant" } },
					{ messageStop: { stopReason: "end_turn" } },
					{ metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
				]),
			});

			const model = createModel();
			const context = createContext();

			const events = [];
			for await (const event of streamBedrock(model, context, {})) {
				events.push(event);
			}

			expect(events[0]).toEqual({
				type: "start",
				partial: expect.objectContaining({
					role: "assistant",
					content: [],
					api: "bedrock-converse",
					provider: "bedrock",
				}),
			});
		});

		it("yields text_start and text_delta events", async () => {
			mockSend.mockResolvedValue({
				stream: createMockStream([
					{ messageStart: { role: "assistant" } },
					{ contentBlockStart: { contentBlockIndex: 0 } },
					{
						contentBlockDelta: {
							contentBlockIndex: 0,
							delta: { text: "Hello, " },
						},
					},
					{
						contentBlockDelta: {
							contentBlockIndex: 0,
							delta: { text: "world!" },
						},
					},
					{ contentBlockStop: { contentBlockIndex: 0 } },
					{ messageStop: { stopReason: "end_turn" } },
					{ metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
				]),
			});

			const model = createModel();
			const context = createContext();

			const events = [];
			for await (const event of streamBedrock(model, context, {})) {
				events.push(event);
			}

			expect(events).toContainEqual(
				expect.objectContaining({ type: "text_start", contentIndex: 0 }),
			);
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "text_delta",
					contentIndex: 0,
					delta: "Hello, ",
				}),
			);
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "text_delta",
					contentIndex: 0,
					delta: "world!",
				}),
			);
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "text_end",
					contentIndex: 0,
					content: "Hello, world!",
				}),
			);
		});

		it("yields toolcall events for tool use", async () => {
			mockSend.mockResolvedValue({
				stream: createMockStream([
					{ messageStart: { role: "assistant" } },
					{
						contentBlockStart: {
							contentBlockIndex: 0,
							start: {
								toolUse: { toolUseId: "tool-123", name: "read_file" },
							},
						},
					},
					{
						contentBlockDelta: {
							contentBlockIndex: 0,
							delta: { toolUse: { input: '{"path":' } },
						},
					},
					{
						contentBlockDelta: {
							contentBlockIndex: 0,
							delta: { toolUse: { input: '"/test.txt"}' } },
						},
					},
					{ contentBlockStop: { contentBlockIndex: 0 } },
					{ messageStop: { stopReason: "tool_use" } },
					{ metadata: { usage: { inputTokens: 10, outputTokens: 15 } } },
				]),
			});

			const model = createModel();
			const context = createContext();

			const events = [];
			for await (const event of streamBedrock(model, context, {})) {
				events.push(event);
			}

			expect(events).toContainEqual(
				expect.objectContaining({ type: "toolcall_start", contentIndex: 0 }),
			);
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "toolcall_end",
					contentIndex: 0,
					toolCall: expect.objectContaining({
						id: "tool-123",
						name: "read_file",
						arguments: { path: "/test.txt" },
					}),
				}),
			);
		});

		it("yields done event with usage", async () => {
			mockSend.mockResolvedValue({
				stream: createMockStream([
					{ messageStart: { role: "assistant" } },
					{ contentBlockStart: { contentBlockIndex: 0 } },
					{
						contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hi!" } },
					},
					{ contentBlockStop: { contentBlockIndex: 0 } },
					{ messageStop: { stopReason: "end_turn" } },
					{ metadata: { usage: { inputTokens: 100, outputTokens: 50 } } },
				]),
			});

			const model = createModel();
			const context = createContext();

			const events = [];
			for await (const event of streamBedrock(model, context, {})) {
				events.push(event);
			}

			const doneEvent = events.find((e) => e.type === "done");
			expect(doneEvent).toBeDefined();
			expect(doneEvent).toEqual(
				expect.objectContaining({
					type: "done",
					reason: "stop",
					message: expect.objectContaining({
						usage: expect.objectContaining({
							input: 100,
							output: 50,
						}),
					}),
				}),
			);
		});

		it("handles different stop reasons", async () => {
			const stopReasonMap: Record<string, string> = {
				end_turn: "stop",
				max_tokens: "length",
				tool_use: "toolUse",
			};

			for (const [bedrockReason, expectedReason] of Object.entries(
				stopReasonMap,
			)) {
				vi.clearAllMocks();
				mockSend.mockResolvedValue({
					stream: createMockStream([
						{ messageStart: { role: "assistant" } },
						{ messageStop: { stopReason: bedrockReason } },
						{ metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
					]),
				});

				const model = createModel();
				const context = createContext();

				const events = [];
				for await (const event of streamBedrock(model, context, {})) {
					events.push(event);
				}

				const doneEvent = events.find((e) => e.type === "done");
				expect(doneEvent?.reason).toBe(expectedReason);
			}
		});
	});

	describe("Error Handling", () => {
		it("throws error when stream is undefined", async () => {
			mockSend.mockResolvedValue({ stream: undefined });

			const model = createModel();
			const context = createContext();

			await expect(async () => {
				for await (const _ of streamBedrock(model, context, {})) {
					// consume events
				}
			}).rejects.toThrow("Response stream is undefined");
		});
	});
});

describe("Bedrock Model Configuration", () => {
	it("supports Writer Palmyra X5 model", () => {
		const model: Model<"bedrock-converse"> = {
			id: "writer.palmyra-x5-v1:0",
			name: "Palmyra X5 (Bedrock)",
			api: "bedrock-converse",
			provider: "bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			reasoning: true,
			toolUse: true,
			input: ["text"],
			cost: {
				input: 0.6,
				output: 6.0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 1040000,
			maxTokens: 8192,
		};

		expect(model.api).toBe("bedrock-converse");
		expect(model.provider).toBe("bedrock");
		expect(model.contextWindow).toBe(1040000);
		expect(model.reasoning).toBe(true);
	});

	it("supports Claude models on Bedrock", () => {
		const model: Model<"bedrock-converse"> = {
			id: "anthropic.claude-3-5-sonnet-20241022-v2:0",
			name: "Claude 3.5 Sonnet v2 (Bedrock)",
			api: "bedrock-converse",
			provider: "bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			reasoning: false,
			toolUse: true,
			input: ["text", "image"],
			cost: {
				input: 3.0,
				output: 15.0,
				cacheRead: 0.3,
				cacheWrite: 3.75,
			},
			contextWindow: 200000,
			maxTokens: 8192,
		};

		expect(model.api).toBe("bedrock-converse");
		expect(model.input).toContain("image");
		expect(model.cost.cacheRead).toBe(0.3);
	});

	it("supports Llama models on Bedrock", () => {
		const model: Model<"bedrock-converse"> = {
			id: "meta.llama3-1-405b-instruct-v1:0",
			name: "Llama 3.1 405B Instruct (Bedrock)",
			api: "bedrock-converse",
			provider: "bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			reasoning: false,
			toolUse: true,
			input: ["text"],
			cost: {
				input: 5.32,
				output: 16.0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 128000,
			maxTokens: 4096,
		};

		expect(model.api).toBe("bedrock-converse");
		expect(model.contextWindow).toBe(128000);
		expect(model.toolUse).toBe(true);
	});
});
