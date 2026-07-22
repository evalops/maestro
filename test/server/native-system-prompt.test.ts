import { describe, expect, it } from "vitest";
import { resolveNativeSystemPrompt } from "../../src/server/native-system-prompt.js";

describe("resolveNativeSystemPrompt", () => {
	it("returns an explicit systemPrompt without resolving", async () => {
		const prompt = await resolveNativeSystemPrompt({
			systemPrompt: "explicit override",
			cwd: process.cwd(),
		});
		expect(prompt).toEqual({ systemPrompt: "explicit override" });
	});

	it("returns empty string when explicitly provided", async () => {
		const prompt = await resolveNativeSystemPrompt({
			systemPrompt: "",
		});
		expect(prompt).toEqual({ systemPrompt: "" });
	});

	it("resolves a non-empty Maestro system prompt by default", async () => {
		const prompt = await resolveNativeSystemPrompt({
			cwd: process.cwd(),
		});
		expect(prompt.systemPrompt.length).toBeGreaterThan(0);
		expect(prompt.promptMetadata).toBeDefined();
		expect(prompt.promptContextManifest).toBeDefined();
		expect(prompt.systemPromptSourcePaths).toBeDefined();
	});
});
