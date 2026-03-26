import { describe, expect, it } from "vitest";
import {
	extractAssistantText,
	matchesExactSentinelResponse,
	normalizeAssistantText,
} from "../../scripts/evals/run-openrouter-live-smoke";

describe("openrouter live smoke helpers", () => {
	it("normalizes surrounding whitespace before exact sentinel comparison", () => {
		expect(normalizeAssistantText("\nMAESTRO_OK\r\n")).toBe("MAESTRO_OK");
		expect(matchesExactSentinelResponse("\nMAESTRO_OK\n", "MAESTRO_OK")).toBe(
			true,
		);
	});

	it("fails when the sentinel is only a substring of the response", () => {
		expect(
			matchesExactSentinelResponse(
				"Here is your answer: MAESTRO_OK",
				"MAESTRO_OK",
			),
		).toBe(false);
		expect(
			matchesExactSentinelResponse(
				"MAESTRO_OK and one extra sentence.",
				"MAESTRO_OK",
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
					{ type: "text", text: "MAESTRO_OK" },
					{ type: "text", text: "SECOND_LINE" },
				],
			},
		]);

		expect(assistantText).toBe("MAESTRO_OK\nSECOND_LINE");
	});
});
