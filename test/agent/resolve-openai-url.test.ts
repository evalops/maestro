import { describe, expect, it } from "vitest";
import { resolveOpenAIUrlForTest } from "../../src/agent/providers/openai.js";

describe("resolveOpenAIUrl", () => {
	it("appends path before query params for direct URLs", () => {
		const url = resolveOpenAIUrlForTest(
			"https://api.example.com/v1?key=value",
			"openai-responses",
		);
		expect(url).toBe("https://api.example.com/v1/responses?key=value");
	});

	it("replaces chat completions with responses for direct OpenRouter URLs", () => {
		const url = resolveOpenAIUrlForTest(
			"https://openrouter.ai/api/v1/chat/completions?key=value",
			"openai-responses",
		);
		expect(url).toBe("https://openrouter.ai/api/v1/responses?key=value");
	});

	it("appends path before query params for proxied upstream URLs", () => {
		const proxy = `https://proxy.test/?url=${encodeURIComponent(
			"https://api.example.com/v1?key=value",
		)}`;
		const url = resolveOpenAIUrlForTest(proxy, "openai-completions");
		expect(url).toBe(
			`https://proxy.test/?url=${encodeURIComponent(
				"https://api.example.com/v1/chat/completions?key=value",
			)}`,
		);
	});

	it("leaves URLs untouched if endpoint already present", () => {
		const url = resolveOpenAIUrlForTest(
			"https://api.example.com/v1/responses?key=value",
			"openai-responses",
		);
		expect(url).toBe("https://api.example.com/v1/responses?key=value");
	});
});
