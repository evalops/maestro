import { describe, expect, it } from "vitest";
import {
	countTokens,
	encodingForModel,
} from "../../src/agent/token-counter.js";

describe("token-counter", () => {
	describe("encodingForModel", () => {
		it("maps GPT-4o / o-series to o200k_base", () => {
			expect(encodingForModel("gpt-4o")).toBe("o200k_base");
			expect(encodingForModel("gpt-4o-mini")).toBe("o200k_base");
			expect(encodingForModel("o3-mini")).toBe("o200k_base");
			expect(encodingForModel("gpt-5")).toBe("o200k_base");
		});

		it("maps GPT-4 / GPT-3.5 to cl100k_base", () => {
			expect(encodingForModel("gpt-4")).toBe("cl100k_base");
			expect(encodingForModel("gpt-4-turbo")).toBe("cl100k_base");
			expect(encodingForModel("gpt-3.5-turbo")).toBe("cl100k_base");
		});

		it("returns null for providers without a bundled tokenizer", () => {
			expect(encodingForModel("claude-sonnet-4-5")).toBeNull();
			expect(encodingForModel("gemini-2.5-pro")).toBeNull();
			expect(encodingForModel("unknown-model")).toBeNull();
		});
	});

	describe("countTokens", () => {
		it("counts accurately for GPT-4o (o200k_base)", () => {
			// Known: "Hello, world!" tokenizes to 4 under o200k_base.
			expect(countTokens("Hello, world!", "gpt-4o")).toBe(4);
		});

		it("is more accurate than bytes/4 for code", () => {
			// bytes/4 says ceil(35/4)=9; real o200k count is 13.
			const code = "function add(a, b) { return a + b; }";
			expect(countTokens(code, "gpt-4o")).toBe(13);
			expect(countTokens(code, "gpt-4o")).toBeGreaterThan(9);
		});

		it("falls back to bytes/4 for non-OpenAI providers", () => {
			// Claude/Gemini: no bundled tokenizer -> heuristic. Must be > 0 and
			// deterministic-ish (chars/4).
			const text = "Hello, world!";
			expect(countTokens(text, "claude-sonnet-4-5")).toBe(
				Math.max(1, Math.ceil(text.length / 4)),
			);
		});

		it("falls back to bytes/4 when no model is given", () => {
			expect(countTokens("Hello, world!")).toBe(
				Math.max(1, Math.ceil("Hello, world!".length / 4)),
			);
		});
	});
});
