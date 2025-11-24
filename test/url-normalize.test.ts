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

	it("does not append twice for malformed URLs that already include endpoint with query", () => {
		const url = normalizeLLMBaseUrl(
			"malformed.com/v1/responses?key=value",
			"openai",
			"openai-responses",
		);
		expect(url).toBe("malformed.com/v1/responses?key=value");
	});

	it("rejects proxy upstream with unsafe protocol", () => {
		const url = normalizeLLMBaseUrl(
			"https://proxy.test/?url=file://etc/passwd",
			"openai",
			"openai-completions",
		);
		expect(url).toBe("https://proxy.test/?url=file://etc/passwd");
	});

	it("rejects proxy upstream to private ip literal", () => {
		const url = normalizeLLMBaseUrl(
			"https://proxy.test/?url=http://192.168.1.5/v1",
			"openai",
			"openai-completions",
		);
		expect(url).toBe("https://proxy.test/?url=http://192.168.1.5/v1");
	});

	it("rejects empty proxy upstream", () => {
		const url = normalizeLLMBaseUrl(
			"https://proxy.test/?url=",
			"openai",
			"openai-completions",
		);
		expect(url).toBe("https://proxy.test/?url=");
	});

	it("string fallback does not match path fragment in hostname", () => {
		const url = normalizeLLMBaseUrl(
			"https://chat.completions.example.com/api/v1",
			"openai",
			"openai-completions",
		);
		expect(url).toBe(
			"https://chat.completions.example.com/api/v1/chat/completions",
		);
	});
});
