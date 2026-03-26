/**
 * Tests for provider-aware context overflow detection (#850)
 *
 * This test suite validates that context overflow errors are correctly
 * identified across all supported providers using pattern matching.
 */

import { describe, expect, it } from "vitest";
import type { Api, Model, Usage } from "../src/agent/types.js";
import {
	explainOverflow,
	isContextOverflow,
	isSilentOverflow,
} from "../src/utils/context-overflow.js";

describe("Context Overflow Detection", () => {
	describe("Anthropic Error Patterns", () => {
		it("should detect 'prompt is too long' error", () => {
			const error = new Error("prompt is too long: 150000 tokens");
			expect(isContextOverflow(error)).toBe(true);
		});

		it("should detect 'max_tokens exceeded' error", () => {
			const error = new Error("max_tokens: maximum of 100000 tokens exceeded");
			expect(isContextOverflow(error)).toBe(true);
		});

		it("should handle string errors", () => {
			expect(isContextOverflow("prompt is too long")).toBe(true);
		});
	});

	describe("OpenAI Error Patterns", () => {
		it("should detect 'maximum context length' error", () => {
			const error = new Error(
				"This model's maximum context length is 128000 tokens. However, you requested 150000 tokens",
			);
			expect(isContextOverflow(error)).toBe(true);
		});

		it("should detect 'context_length_exceeded' error", () => {
			const error = new Error("context_length_exceeded");
			expect(isContextOverflow(error)).toBe(true);
		});

		it("should detect 'reduce the length of the messages' error", () => {
			const error = new Error("Please reduce the length of the messages");
			expect(isContextOverflow(error)).toBe(true);
		});
	});

	describe("Google Error Patterns", () => {
		it("should detect 'exceeds the maximum number of tokens' error", () => {
			const error = new Error(
				"Request exceeds the maximum number of tokens: 2000000",
			);
			expect(isContextOverflow(error)).toBe(true);
		});

		it("should not detect token quota RESOURCE_EXHAUSTED errors as overflow", () => {
			const error = new Error(
				"429 RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'generate_content_tokens_per_model_per_minute' and limit 'Generate content tokens per minute per project per base model'",
			);
			expect(isContextOverflow(error)).toBe(false);
		});
	});

	describe("Groq Error Patterns", () => {
		it("should detect precise context length overflow errors", () => {
			const error = new Error("context length exceeded");
			expect(isContextOverflow(error)).toBe(true);
		});

		it("should detect 'token limit exceeded' error", () => {
			const error = new Error("token limit exceeded");
			expect(isContextOverflow(error)).toBe(true);
		});

		it("should not misclassify token rate limits as overflow", () => {
			const error = new Error(
				"Your token limit for this minute has been exceeded",
			);
			expect(isContextOverflow(error)).toBe(false);
		});
	});

	describe("Bedrock Error Patterns", () => {
		it("should detect 'too many input tokens' error", () => {
			const error = new Error("too many input tokens: 250000");
			expect(isContextOverflow(error)).toBe(true);
		});

		it("should detect 'ValidationException' with token mention", () => {
			const error = new Error(
				"ValidationException: The input token count exceeds the limit",
			);
			expect(isContextOverflow(error)).toBe(true);
		});
	});

	describe("Generic Patterns", () => {
		it("should detect 'exceeds the context window' error", () => {
			const error = new Error("Request exceeds the context window");
			expect(isContextOverflow(error)).toBe(true);
		});

		it("should detect 'request too large' error", () => {
			const error = new Error("request too large");
			expect(isContextOverflow(error)).toBe(true);
		});
	});

	describe("Non-overflow Errors", () => {
		it("should not detect unrelated errors", () => {
			const errors = [
				new Error("Network connection failed"),
				new Error("API key invalid"),
				new Error("Model not found"),
				new Error("Rate limit exceeded"),
			];

			for (const error of errors) {
				expect(isContextOverflow(error)).toBe(false);
			}
		});

		it("should handle empty strings", () => {
			expect(isContextOverflow("")).toBe(false);
		});
	});

	describe("Silent Overflow Detection", () => {
		const mockModel: Model<Api> = {
			id: "gpt-4",
			provider: "openai",
			api: "openai",
			contextWindow: 128000,
			name: "GPT-4",
			maxTokens: 4096,
			cost: {
				input: 0.03,
				output: 0.06,
				cacheRead: 0,
				cacheWrite: 0,
			},
		};

		it("should detect silent overflow when usage exceeds context window", () => {
			const usage: Usage = {
				input: 150000, // Exceeds 128000
				output: 1000,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};

			expect(isSilentOverflow(usage, mockModel)).toBe(true);
		});

		it("should not detect overflow when usage is within limits", () => {
			const usage: Usage = {
				input: 100000, // Within 128000
				output: 1000,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};

			expect(isSilentOverflow(usage, mockModel)).toBe(false);
		});

		it("should handle missing model gracefully", () => {
			const usage: Usage = {
				input: 150000,
				output: 1000,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};

			expect(isSilentOverflow(usage, undefined)).toBe(false);
		});

		it("should consider cache tokens in total", () => {
			const usage: Usage = {
				input: 50000,
				output: 1000,
				cacheRead: 30000,
				cacheWrite: 50000, // 50k + 30k + 50k = 130k > 128k
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};

			expect(isSilentOverflow(usage, mockModel)).toBe(true);
		});

		it("should treat missing cacheRead as zero", () => {
			const usage = {
				input: 150000,
				output: 1000,
				cacheRead: undefined,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			} as Usage;

			expect(isSilentOverflow(usage, mockModel)).toBe(true);
		});
	});

	describe("Edge Cases", () => {
		it("should handle Error objects with no message", () => {
			const error = new Error();
			expect(isContextOverflow(error)).toBe(false);
		});

		it("should handle null/undefined gracefully", () => {
			// @ts-expect-error - testing runtime behavior
			expect(isContextOverflow(null)).toBe(false);
			// @ts-expect-error - testing runtime behavior
			expect(isContextOverflow(undefined)).toBe(false);
		});

		it("should be case-insensitive", () => {
			expect(isContextOverflow("PROMPT IS TOO LONG")).toBe(true);
			expect(isContextOverflow("Context Length Exceeded")).toBe(true);
		});
	});

	describe("Real-world Examples", () => {
		it("should detect real Anthropic overflow", () => {
			const error = new Error(
				'{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 203895 tokens > 200000 maximum"}}',
			);
			expect(isContextOverflow(error)).toBe(true);
		});

		it("should detect real OpenAI overflow", () => {
			const error = new Error(
				"This model's maximum context length is 128000 tokens. However, you requested 150423 tokens (146327 in the messages, 4096 in the completion). Please reduce the length of the messages or completion.",
			);
			expect(isContextOverflow(error)).toBe(true);
		});

		it("should detect real Google overflow", () => {
			const error = new Error(
				"400 INVALID_ARGUMENT: Request payload size exceeds the limit: 2000000 bytes, but the actual size is 2500000 bytes, containing 250000 tokens. Please reduce the size of the request.",
			);
			expect(isContextOverflow(error)).toBe(true);
		});
	});

	describe("Overflow Explanations", () => {
		it("should retain parsed token details when model is provided", () => {
			const error = new Error(
				"prompt is too long: 203895 tokens > 200000 maximum",
			);
			const model = {
				id: "claude-sonnet-4",
				provider: "anthropic",
				api: "anthropic-messages",
				contextWindow: 200000,
				name: "Claude Sonnet 4",
				maxTokens: 8192,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
				reasoning: true,
				input: ["text"],
				baseUrl: "https://api.anthropic.com/v1",
			} as Model<Api>;

			expect(explainOverflow(error, model)).toContain("203,895 tokens");
			expect(explainOverflow(error, model)).toContain("200,000 tokens");
		});
	});
});
