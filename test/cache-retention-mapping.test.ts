/**
 * Tests for unified cache retention abstraction across providers.
 *
 * Issue #852: Unified cache retention abstraction across providers
 *
 * This test suite validates that the CacheRetention enum correctly maps
 * to provider-specific caching parameters (Anthropic's cache_control,
 * OpenAI's automatic caching) according to the specification in the issue.
 */

import { describe, expect, it } from "vitest";
import {
	type CacheRetention,
	shouldEnableAnthropicCaching,
	shouldEnableOpenAICaching,
} from "../src/agent/cache-retention-mapper.js";

describe("Cache Retention Mapping", () => {
	describe("Type safety", () => {
		it("should have all expected cache retention levels", () => {
			const levels: CacheRetention[] = ["none", "short", "long"];

			// This test exists to ensure the CacheRetention type is complete
			expect(levels.length).toBe(3);
		});
	});

	describe("Anthropic Cache Control Mapping", () => {
		it('should return false for "none"', () => {
			expect(shouldEnableAnthropicCaching("none")).toBe(false);
		});

		it('should return true for "short"', () => {
			expect(shouldEnableAnthropicCaching("short")).toBe(true);
		});

		it('should return true for "long"', () => {
			expect(shouldEnableAnthropicCaching("long")).toBe(true);
		});

		it("should handle undefined as disabled", () => {
			expect(shouldEnableAnthropicCaching(undefined)).toBe(false);
		});
	});

	describe("OpenAI Caching Mapping", () => {
		it('should return false for "none"', () => {
			expect(shouldEnableOpenAICaching("none")).toBe(false);
		});

		it('should return false for "short" (OpenAI automatic caching)', () => {
			// OpenAI has automatic caching, so "short" doesn't need explicit enabling
			expect(shouldEnableOpenAICaching("short")).toBe(false);
		});

		it('should return true for "long" (explicit 24h retention)', () => {
			expect(shouldEnableOpenAICaching("long")).toBe(true);
		});

		it("should handle undefined as disabled", () => {
			expect(shouldEnableOpenAICaching(undefined)).toBe(false);
		});
	});

	describe("Cross-provider consistency", () => {
		it('should consistently disable caching for "none"', () => {
			expect(shouldEnableAnthropicCaching("none")).toBe(false);
			expect(shouldEnableOpenAICaching("none")).toBe(false);
		});

		it('should enable caching for "long" across providers', () => {
			expect(shouldEnableAnthropicCaching("long")).toBe(true);
			expect(shouldEnableOpenAICaching("long")).toBe(true);
		});
	});

	describe("Provider-specific behavior", () => {
		it("should enable Anthropic caching for short retention", () => {
			// Anthropic benefits from explicit cache_control even for short durations
			expect(shouldEnableAnthropicCaching("short")).toBe(true);
		});

		it("should NOT enable explicit OpenAI caching for short retention", () => {
			// OpenAI has automatic caching, explicit control only needed for "long"
			expect(shouldEnableOpenAICaching("short")).toBe(false);
		});
	});

	describe("Default behavior", () => {
		it("should treat undefined as no caching", () => {
			expect(shouldEnableAnthropicCaching(undefined)).toBe(false);
			expect(shouldEnableOpenAICaching(undefined)).toBe(false);
		});
	});

	describe("Edge cases", () => {
		it("should handle null gracefully", () => {
			// @ts-expect-error - testing runtime behavior with invalid input
			expect(shouldEnableAnthropicCaching(null)).toBe(false);
			// @ts-expect-error - testing runtime behavior with invalid input
			expect(shouldEnableOpenAICaching(null)).toBe(false);
		});

		it("should handle invalid retention values", () => {
			// @ts-expect-error - testing runtime behavior with invalid input
			expect(shouldEnableAnthropicCaching("invalid")).toBe(false);
			// @ts-expect-error - testing runtime behavior with invalid input
			expect(shouldEnableOpenAICaching("invalid")).toBe(false);
		});
	});

	describe("Documentation examples", () => {
		it("should match documented behavior for interactive use (short)", () => {
			// Default for interactive use should be "short"
			const retention: CacheRetention = "short";

			// Anthropic should enable caching
			expect(shouldEnableAnthropicCaching(retention)).toBe(true);

			// OpenAI uses automatic caching (no explicit flag needed)
			expect(shouldEnableOpenAICaching(retention)).toBe(false);
		});

		it("should match documented behavior for one-shot use (none)", () => {
			// Default for one-shot/eval use should be "none"
			const retention: CacheRetention = "none";

			expect(shouldEnableAnthropicCaching(retention)).toBe(false);
			expect(shouldEnableOpenAICaching(retention)).toBe(false);
		});

		it("should match documented behavior for long sessions (long)", () => {
			// Long retention for extended sessions
			const retention: CacheRetention = "long";

			// Both providers should enable explicit caching
			expect(shouldEnableAnthropicCaching(retention)).toBe(true);
			expect(shouldEnableOpenAICaching(retention)).toBe(true);
		});
	});
});
