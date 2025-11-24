import { describe, expect, it } from "vitest";
import { getModel } from "../src/models/builtin.js";

describe("Built-in model registry", () => {
	it("includes OpenRouter models wired to OpenAI-compatible endpoints", () => {
		const model = getModel("openrouter", "anthropic/claude-sonnet-4.5");
		expect(model).toBeTruthy();
		expect(model?.provider).toBe("openrouter");
		expect(model?.api).toBe("openai-completions");
		// openrouter base host should normalize to chat/completions endpoint
		expect(model?.baseUrl).toContain(
			"https://openrouter.ai/api/v1/chat/completions",
		);
	});

	it("includes OpenRouter responses overlay models normalized to /responses", () => {
		const model = getModel("openrouter", "openai/o4-mini");
		expect(model).toBeTruthy();
		expect(model?.api).toBe("openai-responses");
		expect(model?.baseUrl).toBe("https://openrouter.ai/api/v1/responses");
	});

	it("includes OpenAI Codex responses overlay models normalized to /responses", () => {
		const model = getModel("openai", "gpt-5.1-codex-mini");
		expect(model).toBeTruthy();
		expect(model?.api).toBe("openai-responses");
		expect(model?.baseUrl).toBe("https://api.openai.com/v1/responses");
	});

	it("includes Groq responses overlay models normalized to /responses", () => {
		const model = getModel("groq", "openai/gpt-oss-20b");
		expect(model).toBeTruthy();
		expect(model?.api).toBe("openai-responses");
		expect(model?.baseUrl).toBe("https://api.groq.com/openai/v1/responses");
	});
});
