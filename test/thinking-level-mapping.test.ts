/**
 * Tests for unified thinking level abstraction across providers.
 *
 * Issue #853: Unified thinking level abstraction across providers
 *
 * This test suite validates that the ThinkingLevel enum correctly maps
 * to provider-specific parameters (Anthropic budget tokens, OpenAI reasoning_effort,
 * Google thinkingBudgets) according to the specification in the issue.
 */

import { describe, expect, it } from "vitest";
import type { ThinkingLevel } from "../src/agent/types.js";
import {
	mapThinkingLevelToAnthropicBudget,
	mapThinkingLevelToGoogleBudget,
	mapThinkingLevelToOpenAIEffort,
} from "../src/agent/thinking-level-mapper.js";

describe("Thinking Level Mapping", () => {
	describe("Type safety", () => {
		it("should have all expected thinking levels", () => {
			const levels: ThinkingLevel[] = [
				"off",
				"minimal",
				"low",
				"medium",
				"high",
				"ultra",
				"max",
			];

			// This test exists to ensure the ThinkingLevel type is complete
			expect(levels.length).toBe(7);
		});
	});

	describe("Anthropic Budget Token Mapping", () => {
		it('should return undefined for "off"', () => {
			expect(mapThinkingLevelToAnthropicBudget("off")).toBeUndefined();
		});

		it('should map "minimal" to 1024 tokens', () => {
			expect(mapThinkingLevelToAnthropicBudget("minimal")).toBe(1024);
		});

		it('should map "low" to 2048 tokens', () => {
			expect(mapThinkingLevelToAnthropicBudget("low")).toBe(2048);
		});

		it('should map "medium" to 4096 tokens', () => {
			expect(mapThinkingLevelToAnthropicBudget("medium")).toBe(4096);
		});

		it('should map "high" to 8192 tokens', () => {
			expect(mapThinkingLevelToAnthropicBudget("high")).toBe(8192);
		});

		it('should map "ultra" to 16384 tokens', () => {
			expect(mapThinkingLevelToAnthropicBudget("ultra")).toBe(16384);
		});

		it('should map "max" to 32768 tokens (maximum budget)', () => {
			expect(mapThinkingLevelToAnthropicBudget("max")).toBe(32768);
		});
	});

	describe("OpenAI Reasoning Effort Mapping", () => {
		it('should return undefined for "off"', () => {
			expect(mapThinkingLevelToOpenAIEffort("off")).toBeUndefined();
		});

		it('should map "minimal" to "low"', () => {
			expect(mapThinkingLevelToOpenAIEffort("minimal")).toBe("low");
		});

		it('should map "low" to "low"', () => {
			expect(mapThinkingLevelToOpenAIEffort("low")).toBe("low");
		});

		it('should map "medium" to "medium"', () => {
			expect(mapThinkingLevelToOpenAIEffort("medium")).toBe("medium");
		});

		it('should map "high" to "high"', () => {
			expect(mapThinkingLevelToOpenAIEffort("high")).toBe("high");
		});

		it('should map "ultra" to "high" (OpenAI max)', () => {
			expect(mapThinkingLevelToOpenAIEffort("ultra")).toBe("high");
		});

		it('should map "max" to "high" (OpenAI max)', () => {
			expect(mapThinkingLevelToOpenAIEffort("max")).toBe("high");
		});
	});

	describe("Google Gemini Budget Mapping", () => {
		it('should return undefined for "off"', () => {
			expect(mapThinkingLevelToGoogleBudget("off")).toBeUndefined();
		});

		it('should map "minimal" to 1024 tokens', () => {
			expect(mapThinkingLevelToGoogleBudget("minimal")).toBe(1024);
		});

		it('should map "low" to 2048 tokens', () => {
			expect(mapThinkingLevelToGoogleBudget("low")).toBe(2048);
		});

		it('should map "medium" to 8192 tokens', () => {
			expect(mapThinkingLevelToGoogleBudget("medium")).toBe(8192);
		});

		it('should map "high" to 16384 tokens', () => {
			expect(mapThinkingLevelToGoogleBudget("high")).toBe(16384);
		});

		it('should map "ultra" to 32768 tokens', () => {
			expect(mapThinkingLevelToGoogleBudget("ultra")).toBe(32768);
		});

		it('should map "max" to 65536 tokens (maximum)', () => {
			expect(mapThinkingLevelToGoogleBudget("max")).toBe(65536);
		});
	});

	describe("Cross-provider consistency", () => {
		it("should have consistent off/disabled behavior", () => {
			expect(mapThinkingLevelToAnthropicBudget("off")).toBeUndefined();
			expect(mapThinkingLevelToOpenAIEffort("off")).toBeUndefined();
			expect(mapThinkingLevelToGoogleBudget("off")).toBeUndefined();
		});

		it("should have consistent minimal level mappings", () => {
			// All providers should use lowest tier for minimal
			expect(mapThinkingLevelToAnthropicBudget("minimal")).toBe(1024);
			expect(mapThinkingLevelToOpenAIEffort("minimal")).toBe("low");
			expect(mapThinkingLevelToGoogleBudget("minimal")).toBe(1024);
		});

		it("should have progressive budget increases from low to max", () => {
			const anthropicBudgets = [
				mapThinkingLevelToAnthropicBudget("low"),
				mapThinkingLevelToAnthropicBudget("medium"),
				mapThinkingLevelToAnthropicBudget("high"),
				mapThinkingLevelToAnthropicBudget("ultra"),
				mapThinkingLevelToAnthropicBudget("max"),
			];

			const googleBudgets = [
				mapThinkingLevelToGoogleBudget("low"),
				mapThinkingLevelToGoogleBudget("medium"),
				mapThinkingLevelToGoogleBudget("high"),
				mapThinkingLevelToGoogleBudget("ultra"),
				mapThinkingLevelToGoogleBudget("max"),
			];

			// Each level should be strictly greater than the previous
			for (let i = 1; i < anthropicBudgets.length; i++) {
				expect(anthropicBudgets[i]!).toBeGreaterThan(anthropicBudgets[i - 1]!);
			}

			for (let i = 1; i < googleBudgets.length; i++) {
				expect(googleBudgets[i]!).toBeGreaterThan(googleBudgets[i - 1]!);
			}
		});
	});

	describe("Edge cases", () => {
		it("should handle undefined gracefully", () => {
			// @ts-expect-error - testing runtime behavior with invalid input
			expect(mapThinkingLevelToAnthropicBudget(undefined)).toBeUndefined();
			// @ts-expect-error - testing runtime behavior with invalid input
			expect(mapThinkingLevelToOpenAIEffort(undefined)).toBeUndefined();
			// @ts-expect-error - testing runtime behavior with invalid input
			expect(mapThinkingLevelToGoogleBudget(undefined)).toBeUndefined();
		});
	});
});
