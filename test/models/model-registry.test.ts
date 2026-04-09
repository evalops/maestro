import { describe, expect, it } from "vitest";
import { getModel } from "../../src/models/builtin.js";

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

	it("omits Codex subscription models entirely", () => {
		const model = getModel("openai", "gpt-5.1-codex-mini");
		expect(model).toBeNull();
	});

	it("overlays OpenAI GPT-5.2 with correct pricing and endpoints", () => {
		const model = getModel("openai", "gpt-5.2");
		expect(model).toBeTruthy();
		expect(model?.api).toBe("openai-completions");
		expect(model?.baseUrl).toContain("/chat/completions");
		expect(model?.contextWindow).toBe(400000);
		expect(model?.maxTokens).toBe(128000);
		expect(model?.cost.input).toBeCloseTo(1.75);
		expect(model?.cost.output).toBeCloseTo(14);
		expect(model?.cost.cacheRead).toBeCloseTo(0.175);
	});

	it("includes the GPT-5.2 snapshot alias", () => {
		const model = getModel("openai", "gpt-5.2-2025-12-11");
		expect(model).toBeTruthy();
		expect(model?.contextWindow).toBe(400000);
		expect(model?.maxTokens).toBe(128000);
	});

	it("includes Groq responses overlay models normalized to /responses", () => {
		const model = getModel("groq", "openai/gpt-oss-20b");
		expect(model).toBeTruthy();
		expect(model?.api).toBe("openai-responses");
		expect(model?.baseUrl).toBe("https://api.groq.com/openai/v1/responses");
	});

	it("includes EvalOps managed OpenRouter models normalized to the gateway endpoint", () => {
		const model = getModel("evalops-openrouter", "anthropic/claude-sonnet-4.5");
		expect(model).toBeTruthy();
		expect(model?.provider).toBe("evalops-openrouter");
		expect(model?.api).toBe("openai-completions");
		expect(model?.baseUrl).toBe("http://127.0.0.1:8081/v1/chat/completions");
	});

	it("includes EvalOps managed Anthropic models normalized to the gateway endpoint", () => {
		const model = getModel("evalops-anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();
		expect(model?.provider).toBe("evalops-anthropic");
		expect(model?.api).toBe("anthropic-messages");
		expect(model?.baseUrl).toBe("http://127.0.0.1:8081/v1/messages");
	});

	it("includes EvalOps managed Azure OpenAI models normalized to the gateway endpoint", () => {
		const model = getModel("evalops-azure-openai", "gpt-4o");
		expect(model).toBeTruthy();
		expect(model?.provider).toBe("evalops-azure-openai");
		expect(model?.api).toBe("openai-completions");
		expect(model?.baseUrl).toBe("http://127.0.0.1:8081/v1/chat/completions");
	});

	it("includes EvalOps managed Google models normalized to the gateway endpoint", () => {
		const model = getModel("evalops-google", "gemini-2.5-pro");
		expect(model).toBeTruthy();
		expect(model?.provider).toBe("evalops-google");
		expect(model?.api).toBe("openai-completions");
		expect(model?.baseUrl).toBe("http://127.0.0.1:8081/v1/chat/completions");
	});

	it("includes EvalOps managed Groq models normalized to the gateway endpoint", () => {
		const model = getModel("evalops-groq", "llama-3.3-70b-versatile");
		expect(model).toBeTruthy();
		expect(model?.provider).toBe("evalops-groq");
		expect(model?.api).toBe("openai-completions");
		expect(model?.baseUrl).toBe("http://127.0.0.1:8081/v1/chat/completions");
	});

	it("includes EvalOps managed Databricks models normalized to the gateway endpoint", () => {
		const model = getModel(
			"evalops-databricks",
			"databricks-meta-llama-3-3-70b-instruct",
		);
		expect(model).toBeTruthy();
		expect(model?.provider).toBe("evalops-databricks");
		expect(model?.api).toBe("openai-completions");
		expect(model?.baseUrl).toBe("http://127.0.0.1:8081/v1/chat/completions");
	});

	it("includes EvalOps managed Mistral models normalized to the gateway endpoint", () => {
		const model = getModel("evalops-mistral", "mistral-large-latest");
		expect(model).toBeTruthy();
		expect(model?.provider).toBe("evalops-mistral");
		expect(model?.api).toBe("openai-completions");
		expect(model?.baseUrl).toBe("http://127.0.0.1:8081/v1/chat/completions");
	});

	it("includes EvalOps managed xAI models normalized to the gateway endpoint", () => {
		const model = getModel("evalops-xai", "grok-4-fast");
		expect(model).toBeTruthy();
		expect(model?.provider).toBe("evalops-xai");
		expect(model?.api).toBe("openai-completions");
		expect(model?.baseUrl).toBe("http://127.0.0.1:8081/v1/chat/completions");
	});
});
