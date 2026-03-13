import { describe, expect, it } from "vitest";
import {
	extractAssistantText,
	matchesExactSentinelResponse,
	normalizeAssistantText,
} from "../../scripts/evals/run-openrouter-live-smoke";

describe("openrouter live smoke helpers", () => {
	it("normalizes surrounding whitespace before exact sentinel comparison", () => {
		expect(normalizeAssistantText("\nCOMPOSER_OK\r\n")).toBe("COMPOSER_OK");
		expect(matchesExactSentinelResponse("\nCOMPOSER_OK\n", "COMPOSER_OK")).toBe(
			true,
		);
	});

	it("fails when the sentinel is only a substring of the response", () => {
		expect(
			matchesExactSentinelResponse(
				"Here is your answer: COMPOSER_OK",
				"COMPOSER_OK",
			),
		).toBe(false);
		expect(
			matchesExactSentinelResponse(
				"COMPOSER_OK and one extra sentence.",
				"COMPOSER_OK",
			),
		).toBe(false);
	});

	it("extracts the latest assistant text blocks in order", () => {
		const assistantText = extractAssistantText([
			{
				role: "assistant",
				content: [{ type: "text", text: "older" }],
			},
			{
				role: "user",
				content: [{ type: "text", text: "prompt" }],
			},
			{
				role: "assistant",
				content: [
					{ type: "text", text: "COMPOSER_OK" },
					{ type: "text", text: "SECOND_LINE" },
				],
			},
		]);

		expect(assistantText).toBe("COMPOSER_OK\nSECOND_LINE");
	});
});
