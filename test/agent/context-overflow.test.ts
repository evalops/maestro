import { describe, expect, it } from "vitest";
import {
	getOverflowPatterns,
	isContextOverflow,
	parseOverflowDetails,
} from "../../src/agent/context-overflow.js";
import type { AssistantMessage } from "../../src/agent/types.js";

function createErrorMessage(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-20250514",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

function createSuccessMessage(
	usage: { input: number; cacheRead?: number } = { input: 1000 },
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Hello" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-20250514",
		usage: {
			input: usage.input,
			output: 100,
			cacheRead: usage.cacheRead || 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("isContextOverflow", () => {
	describe("Anthropic errors", () => {
		it("detects 'prompt is too long' error", () => {
			const msg = createErrorMessage(
				"prompt is too long: 213462 tokens > 200000 maximum",
			);
			expect(isContextOverflow(msg)).toBe(true);
		});
	});

	describe("OpenAI errors", () => {
		it("detects 'exceeds the context window' error", () => {
			const msg = createErrorMessage(
				"Your input exceeds the context window of this model",
			);
			expect(isContextOverflow(msg)).toBe(true);
		});
	});

	describe("Google Gemini errors", () => {
		it("detects 'input token count exceeds' error", () => {
			const msg = createErrorMessage(
				"The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)",
			);
			expect(isContextOverflow(msg)).toBe(true);
		});
	});

	describe("xAI (Grok) errors", () => {
		it("detects 'maximum prompt length' error", () => {
			const msg = createErrorMessage(
				"This model's maximum prompt length is 131072 but the request contains 537812 tokens",
			);
			expect(isContextOverflow(msg)).toBe(true);
		});
	});

	describe("Groq errors", () => {
		it("detects 'reduce the length' error", () => {
			const msg = createErrorMessage(
				"Please reduce the length of the messages or completion",
			);
			expect(isContextOverflow(msg)).toBe(true);
		});
	});

	describe("OpenRouter errors", () => {
		it("detects 'maximum context length' error", () => {
			const msg = createErrorMessage(
				"This endpoint's maximum context length is 128000 tokens. However, you requested about 150000 tokens",
			);
			expect(isContextOverflow(msg)).toBe(true);
		});
	});

	describe("llama.cpp errors", () => {
		it("detects 'exceeds the available context size' error", () => {
			const msg = createErrorMessage(
				"the request exceeds the available context size, try increasing it",
			);
			expect(isContextOverflow(msg)).toBe(true);
		});
	});

	describe("LM Studio errors", () => {
		it("detects 'greater than the context length' error", () => {
			const msg = createErrorMessage(
				"tokens to keep from the initial prompt is greater than the context length",
			);
			expect(isContextOverflow(msg)).toBe(true);
		});
	});

	describe("Cerebras/Mistral errors", () => {
		it("detects 400 status code with no body", () => {
			const msg = createErrorMessage("400 status code (no body)");
			expect(isContextOverflow(msg)).toBe(true);
		});

		it("detects 413 status code with no body", () => {
			const msg = createErrorMessage("413 (no body)");
			expect(isContextOverflow(msg)).toBe(true);
		});
	});

	describe("Generic fallback patterns", () => {
		it("detects 'context length exceeded' error", () => {
			const msg = createErrorMessage("Error: context length exceeded");
			expect(isContextOverflow(msg)).toBe(true);
		});

		it("detects 'too many tokens' error", () => {
			const msg = createErrorMessage("too many tokens in request");
			expect(isContextOverflow(msg)).toBe(true);
		});

		it("detects 'token limit exceeded' error", () => {
			const msg = createErrorMessage("token limit exceeded");
			expect(isContextOverflow(msg)).toBe(true);
		});
	});

	describe("Silent overflow detection", () => {
		it("detects when usage.input exceeds contextWindow", () => {
			const msg = createSuccessMessage({ input: 150000 });
			expect(isContextOverflow(msg, 128000)).toBe(true);
		});

		it("considers cacheRead tokens", () => {
			const msg = createSuccessMessage({ input: 100000, cacheRead: 50000 });
			expect(isContextOverflow(msg, 128000)).toBe(true);
		});

		it("does not flag when within limits", () => {
			const msg = createSuccessMessage({ input: 100000 });
			expect(isContextOverflow(msg, 128000)).toBe(false);
		});

		it("does not flag without contextWindow parameter", () => {
			const msg = createSuccessMessage({ input: 150000 });
			expect(isContextOverflow(msg)).toBe(false);
		});
	});

	describe("Non-overflow errors", () => {
		it("does not flag unrelated errors", () => {
			const msg = createErrorMessage("Rate limit exceeded");
			expect(isContextOverflow(msg)).toBe(false);
		});

		it("does not flag success messages without contextWindow", () => {
			const msg = createSuccessMessage();
			expect(isContextOverflow(msg)).toBe(false);
		});
	});
});

describe("parseOverflowDetails", () => {
	it("parses Anthropic error format", () => {
		const details = parseOverflowDetails(
			"prompt is too long: 213462 tokens > 200000 maximum",
		);
		expect(details).toEqual({
			requestedTokens: 213462,
			maxTokens: 200000,
		});
	});

	it("parses Google Gemini error format", () => {
		const details = parseOverflowDetails(
			"The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)",
		);
		expect(details).toEqual({
			requestedTokens: 1196265,
			maxTokens: 1048575,
		});
	});

	it("parses xAI error format", () => {
		const details = parseOverflowDetails(
			"This model's maximum prompt length is 131072 but the request contains 537812 tokens",
		);
		expect(details).toEqual({
			requestedTokens: 537812,
			maxTokens: 131072,
		});
	});

	it("parses OpenRouter error format", () => {
		const details = parseOverflowDetails(
			"This endpoint's maximum context length is 128000 tokens. However, you requested about 150000 tokens",
		);
		expect(details).toEqual({
			requestedTokens: 150000,
			maxTokens: 128000,
		});
	});

	it("returns null for unparseable errors", () => {
		const details = parseOverflowDetails("Some random error");
		expect(details).toBeNull();
	});
});

describe("getOverflowPatterns", () => {
	it("returns array of patterns", () => {
		const patterns = getOverflowPatterns();
		expect(Array.isArray(patterns)).toBe(true);
		expect(patterns.length).toBeGreaterThan(5);
		expect(patterns.every((p) => p instanceof RegExp)).toBe(true);
	});
});
