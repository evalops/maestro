import { describe, expect, it } from "vitest";
import { enforceEndpoint } from "../scripts/generate-models.js";

describe("enforceEndpoint", () => {
	it("throws when responses API is paired with /chat/completions", () => {
		expect(() =>
			enforceEndpoint(
				"https://api.example.com/v1/chat/completions",
				"openai",
				"openai-responses",
			),
		).toThrow(/missing \/responses/);
	});

	it("throws when completions API is paired with /responses", () => {
		expect(() =>
			enforceEndpoint(
				"https://api.example.com/v1/responses",
				"openai",
				"openai-completions",
			),
		).toThrow(/missing \/chat\/completions/);
	});

	it("passes when endpoints match APIs", () => {
		expect(
			enforceEndpoint(
				"https://api.example.com/v1/responses",
				"openai",
				"openai-responses",
			),
		).toBe("https://api.example.com/v1/responses");
		expect(
			enforceEndpoint(
				"https://api.example.com/v1/chat/completions",
				"openai",
				"openai-completions",
			),
		).toBe("https://api.example.com/v1/chat/completions");
	});
});
