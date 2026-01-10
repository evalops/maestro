/**
 * Tests for AWS Bedrock SDK Authentication
 *
 * These tests verify that the Bedrock provider correctly integrates with
 * the AWS SDK's credential resolution and client configuration.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Track BedrockRuntimeClient instantiation
const mockClientInstances: Array<{ region?: string }> = [];
const mockSend = vi.fn();

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	return {
		BedrockRuntimeClient: vi.fn().mockImplementation((config) => {
			mockClientInstances.push({ region: config?.region });
			return { send: mockSend };
		}),
		ConverseStreamCommand: vi.fn().mockImplementation((input) => ({
			input,
		})),
	};
});

vi.mock("../../../src/providers/aws-auth.js", () => ({
	getAwsRegion: vi.fn(() => "us-east-1"),
	hasAwsCredentials: vi.fn(() => true),
	buildBedrockUrl: vi.fn(),
	parseBedrockArn: vi.fn(() => null),
	isInferenceProfile: vi.fn(() => false),
	getBedrockStatus: vi.fn(() => ({
		hasCredentials: true,
		region: "us-east-1",
		credentialSources: ["environment"],
	})),
}));

import { streamBedrock } from "../../../src/agent/providers/bedrock.js";
import type { Context, Model } from "../../../src/agent/types.js";
import { getAwsRegion } from "../../../src/providers/aws-auth.js";

describe("Bedrock SDK Authentication", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
		mockClientInstances.length = 0;
		vi.clearAllMocks();
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	const createModel = (): Model<"bedrock-converse"> => ({
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
	});

	const createContext = (): Context => ({
		systemPrompt: "You are a helpful assistant.",
		messages: [
			{
				role: "user",
				content: "Hello",
				timestamp: Date.now(),
			},
		],
		tools: [],
	});

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

	describe("Region Configuration", () => {
		it("uses region from getAwsRegion helper", async () => {
			vi.mocked(getAwsRegion).mockReturnValue("us-west-2");
			mockSend.mockResolvedValue({
				stream: createMockStream([
					{ messageStart: { role: "assistant" } },
					{ messageStop: { stopReason: "end_turn" } },
					{ metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
				]),
			});

			const model = createModel();
			const context = createContext();

			for await (const _ of streamBedrock(model, context, {})) {
				// consume events
			}

			expect(mockClientInstances.length).toBeGreaterThan(0);
			expect(mockClientInstances[0]!.region).toBe("us-west-2");
		});

		it("uses region from options when provided", async () => {
			vi.mocked(getAwsRegion).mockReturnValue("us-east-1");
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
				region: "eu-west-1",
			})) {
				// consume events
			}

			expect(mockClientInstances.some((c) => c.region === "eu-west-1")).toBe(
				true,
			);
		});

		it("caches client instances by region", async () => {
			mockSend.mockResolvedValue({
				stream: createMockStream([
					{ messageStart: { role: "assistant" } },
					{ messageStop: { stopReason: "end_turn" } },
					{ metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
				]),
			});

			const model = createModel();
			const context = createContext();

			// First call
			for await (const _ of streamBedrock(model, context, {})) {
				// consume events
			}

			const initialCount = mockClientInstances.length;

			// Second call with same region - should reuse cached client
			for await (const _ of streamBedrock(model, context, {})) {
				// consume events
			}

			// Client count should not increase for same region
			expect(mockClientInstances.length).toBe(initialCount);
		});
	});

	describe("SDK Credential Chain", () => {
		it("relies on SDK default credential provider chain", async () => {
			// The SDK automatically handles credentials from:
			// - Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
			// - Shared credentials file (~/.aws/credentials)
			// - IAM roles for EC2/ECS/Lambda
			// - Web identity tokens (EKS)
			//
			// We don't need to explicitly pass credentials - the SDK handles it
			mockSend.mockResolvedValue({
				stream: createMockStream([
					{ messageStart: { role: "assistant" } },
					{ messageStop: { stopReason: "end_turn" } },
					{ metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
				]),
			});

			const model = createModel();
			const context = createContext();

			// Should not throw - SDK will resolve credentials
			const events = [];
			for await (const event of streamBedrock(model, context, {})) {
				events.push(event);
			}

			expect(events.length).toBeGreaterThan(0);
		});
	});

	describe("Abort Signal Handling", () => {
		it("passes abort signal to SDK send method", async () => {
			mockSend.mockResolvedValue({
				stream: createMockStream([
					{ messageStart: { role: "assistant" } },
					{ messageStop: { stopReason: "end_turn" } },
					{ metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
				]),
			});

			const model = createModel();
			const context = createContext();
			const controller = new AbortController();

			for await (const _ of streamBedrock(model, context, {
				signal: controller.signal,
			})) {
				// consume events
			}

			// Verify send was called with abortSignal in options
			expect(mockSend).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					abortSignal: controller.signal,
				}),
			);
		});

		it("handles AbortError gracefully", async () => {
			const abortError = new Error("Aborted");
			abortError.name = "AbortError";
			mockSend.mockRejectedValue(abortError);

			const model = createModel();
			const context = createContext();

			const events = [];
			for await (const event of streamBedrock(model, context, {})) {
				events.push(event);
			}

			// Should emit error event with aborted reason
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "error",
					reason: "aborted",
				}),
			);
		});
	});

	describe("Model ID Handling", () => {
		it("passes model ID directly to ConverseStreamCommand", async () => {
			mockSend.mockResolvedValue({
				stream: createMockStream([
					{ messageStart: { role: "assistant" } },
					{ messageStop: { stopReason: "end_turn" } },
					{ metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
				]),
			});

			const model = createModel();
			model.id = "writer.palmyra-x5-v1:0";
			const context = createContext();

			for await (const _ of streamBedrock(model, context, {})) {
				// consume events
			}

			const { ConverseStreamCommand } = await import(
				"@aws-sdk/client-bedrock-runtime"
			);
			expect(ConverseStreamCommand).toHaveBeenCalledWith(
				expect.objectContaining({
					modelId: "writer.palmyra-x5-v1:0",
				}),
			);
		});

		it("handles model IDs with special characters", async () => {
			mockSend.mockResolvedValue({
				stream: createMockStream([
					{ messageStart: { role: "assistant" } },
					{ messageStop: { stopReason: "end_turn" } },
					{ metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
				]),
			});

			const model = createModel();
			// Model IDs can contain colons, dots, and hyphens
			model.id = "anthropic.claude-3-5-sonnet-20241022-v2:0";
			const context = createContext();

			for await (const _ of streamBedrock(model, context, {})) {
				// consume events
			}

			const { ConverseStreamCommand } = await import(
				"@aws-sdk/client-bedrock-runtime"
			);
			expect(ConverseStreamCommand).toHaveBeenCalledWith(
				expect.objectContaining({
					modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
				}),
			);
		});
	});

	describe("SDK Error Handling", () => {
		it("propagates SDK errors", async () => {
			const sdkError = new Error("Access Denied");
			sdkError.name = "AccessDeniedException";
			mockSend.mockRejectedValue(sdkError);

			const model = createModel();
			const context = createContext();

			await expect(async () => {
				for await (const _ of streamBedrock(model, context, {})) {
					// consume events
				}
			}).rejects.toThrow("Access Denied");
		});

		it("handles undefined stream in response", async () => {
			mockSend.mockResolvedValue({ stream: undefined });

			const model = createModel();
			const context = createContext();

			await expect(async () => {
				for await (const _ of streamBedrock(model, context, {})) {
					// consume events
				}
			}).rejects.toThrow("Response stream is undefined");
		});

		it("handles throttling errors from SDK", async () => {
			const throttleError = new Error("Rate exceeded");
			throttleError.name = "ThrottlingException";
			mockSend.mockRejectedValue(throttleError);

			const model = createModel();
			const context = createContext();

			await expect(async () => {
				for await (const _ of streamBedrock(model, context, {})) {
					// consume events
				}
			}).rejects.toThrow("Rate exceeded");
		});

		it("handles validation errors from SDK", async () => {
			const validationError = new Error("Invalid model ID");
			validationError.name = "ValidationException";
			mockSend.mockRejectedValue(validationError);

			const model = createModel();
			const context = createContext();

			await expect(async () => {
				for await (const _ of streamBedrock(model, context, {})) {
					// consume events
				}
			}).rejects.toThrow("Invalid model ID");
		});
	});

	describe("Inference Configuration", () => {
		it("passes maxTokens to SDK", async () => {
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
				maxTokens: 4096,
			})) {
				// consume events
			}

			const { ConverseStreamCommand } = await import(
				"@aws-sdk/client-bedrock-runtime"
			);
			expect(ConverseStreamCommand).toHaveBeenCalledWith(
				expect.objectContaining({
					inferenceConfig: expect.objectContaining({
						maxTokens: 4096,
					}),
				}),
			);
		});

		it("uses model maxTokens as default", async () => {
			mockSend.mockResolvedValue({
				stream: createMockStream([
					{ messageStart: { role: "assistant" } },
					{ messageStop: { stopReason: "end_turn" } },
					{ metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
				]),
			});

			const model = createModel();
			model.maxTokens = 16384;
			const context = createContext();

			for await (const _ of streamBedrock(model, context, {})) {
				// consume events
			}

			const { ConverseStreamCommand } = await import(
				"@aws-sdk/client-bedrock-runtime"
			);
			expect(ConverseStreamCommand).toHaveBeenCalledWith(
				expect.objectContaining({
					inferenceConfig: expect.objectContaining({
						maxTokens: 16384,
					}),
				}),
			);
		});

		it("passes temperature to SDK when specified", async () => {
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
				temperature: 0.5,
			})) {
				// consume events
			}

			const { ConverseStreamCommand } = await import(
				"@aws-sdk/client-bedrock-runtime"
			);
			expect(ConverseStreamCommand).toHaveBeenCalledWith(
				expect.objectContaining({
					inferenceConfig: expect.objectContaining({
						temperature: 0.5,
					}),
				}),
			);
		});

		it("omits temperature when not specified", async () => {
			mockSend.mockResolvedValue({
				stream: createMockStream([
					{ messageStart: { role: "assistant" } },
					{ messageStop: { stopReason: "end_turn" } },
					{ metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
				]),
			});

			const model = createModel();
			const context = createContext();

			for await (const _ of streamBedrock(model, context, {})) {
				// consume events
			}

			const { ConverseStreamCommand } = await import(
				"@aws-sdk/client-bedrock-runtime"
			);
			const call = vi.mocked(ConverseStreamCommand).mock.calls[0]![0];
			expect(call.inferenceConfig?.temperature).toBeUndefined();
		});
	});
});
