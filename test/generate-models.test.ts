import { mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enforceEndpoint } from "../scripts/generate-models.js";

describe("enforceEndpoint", () => {
	const tempDir = join(process.cwd(), ".tmp-models-out");
	const tempOut = join(tempDir, "models.generated.ts");

	beforeEach(() => {
		mkdirSync(tempDir, { recursive: true });
		process.env.MODELS_OUT_PATH = tempOut;
	});

	afterEach(() => {
		process.env.MODELS_OUT_PATH = undefined;
		try {
			unlinkSync(tempOut);
		} catch {
			// ignore
		}
	});

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
