import { describe, expect, it } from "vitest";
import { getModel } from "../src/models/builtin.js";

describe("Built-in model registry", () => {
	it("includes OpenRouter models wired to OpenAI-compatible endpoints", () => {
		const model = getModel("openrouter", "anthropic/claude-sonnet-4-5");
		expect(model).toBeTruthy();
		expect(model?.provider).toBe("openrouter");
		expect(model?.api).toBe("openai-responses");
		expect(model?.baseUrl).toBe(
			"https://openrouter.ai/api/v1/chat/completions",
		);
	});
});
