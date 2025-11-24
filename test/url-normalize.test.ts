import { describe, expect, it } from "vitest";
import { normalizeLLMBaseUrl } from "../src/models/url-normalize.js";

describe("normalizeLLMBaseUrl", () => {
	it("appends endpoint to upstream when baseUrl is a proxy", () => {
		const url = normalizeLLMBaseUrl(
			"https://proxy.test/?url=https://api.openai.com/v1",
			"openai",
			"openai-completions",
		);
		expect(url).toBe(
			"https://proxy.test/?url=https%3A%2F%2Fapi.openai.com%2Fv1%2Fchat%2Fcompletions",
		);
	});

	it("avoids double-appending when upstream already has endpoint", () => {
		const url = normalizeLLMBaseUrl(
			"https://proxy.test/?url=https://api.openai.com/v1/chat/completions",
			"openai",
			"openai-completions",
		);
		expect(url).toBe(
			"https://proxy.test/?url=https://api.openai.com/v1/chat/completions",
		);
	});
});
