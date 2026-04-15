import { describe, expect, it } from "vitest";
import {
	isLocalBaseUrl,
	normalizeBaseUrl,
	normalizeLLMBaseUrl,
	trimTrailingSlash,
} from "../src/models/url-normalize.js";

describe("trimTrailingSlash", () => {
	it("removes single trailing slash", () => {
		expect(trimTrailingSlash("https://api.example.com/")).toBe(
			"https://api.example.com",
		);
	});
	it("leaves string without trailing slash unchanged", () => {
		expect(trimTrailingSlash("https://api.example.com")).toBe(
			"https://api.example.com",
		);
	});
	it("reduces single slash to empty string", () => {
		expect(trimTrailingSlash("/")).toBe("");
	});
	it("leaves empty string unchanged", () => {
		expect(trimTrailingSlash("")).toBe("");
	});
});

describe("isLocalBaseUrl", () => {
	it("returns false for undefined or empty", () => {
		expect(isLocalBaseUrl(undefined)).toBe(false);
		expect(isLocalBaseUrl("")).toBe(false);
	});
	it("returns true for localhost", () => {
		expect(isLocalBaseUrl("http://localhost/")).toBe(true);
		expect(isLocalBaseUrl("http://localhost:8080/v1")).toBe(true);
	});
	it("returns true for 127.0.0.1 and ::1 and 0.0.0.0", () => {
		expect(isLocalBaseUrl("http://127.0.0.1")).toBe(true);
		expect(isLocalBaseUrl("http://[::1]/")).toBe(true);
		expect(isLocalBaseUrl("http://0.0.0.0:3000")).toBe(true);
	});
	it("returns false for non-local hostnames", () => {
		expect(isLocalBaseUrl("https://api.example.com")).toBe(false);
		expect(isLocalBaseUrl("http://192.168.1.1")).toBe(false);
	});
	it("returns false for invalid URL", () => {
		expect(isLocalBaseUrl("not-a-url")).toBe(false);
	});
});

describe("normalizeBaseUrl", () => {
	it("rewrites bedrock to bedrock-runtime for aws provider", () => {
		const url = normalizeBaseUrl(
			"https://bedrock.us-east-1.amazonaws.com",
			"bedrock",
		);
		expect(url).toContain("bedrock-runtime");
	});
	it("leaves non-matching provider URLs unchanged for path", () => {
		const url = "https://api.anthropic.com/v1/messages";
		expect(normalizeBaseUrl(url, "anthropic")).toBe(url);
	});
});

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
