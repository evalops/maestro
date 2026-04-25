import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetFeatureFlagCacheForTests } from "../../src/config/feature-flags.js";
import { getModel, getProviders } from "../../src/models/builtin.js";
import {
	expectedManagedGatewayModelAPI,
	expectedManagedGatewayModelBaseURL,
	managedGatewayAliasDefinitions,
} from "../testing/evalops-managed.js";

describe("Built-in model registry", () => {
	afterEach(() => {
		Reflect.deleteProperty(process.env, "EVALOPS_FEATURE_FLAGS_PATH");
		resetFeatureFlagCacheForTests();
	});

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

	it("does not mix Codex subscription models into the Platform OpenAI provider", () => {
		const model = getModel("openai", "gpt-5.1-codex-mini");
		expect(model).toBeNull();
	});

	it("exposes Codex subscription models through the OpenAI Codex provider", () => {
		const model = getModel("openai-codex", "gpt-5.5");
		expect(model).toBeTruthy();
		expect(model?.provider).toBe("openai-codex");
		expect(model?.api).toBe("openai-codex-responses");
		expect(model?.baseUrl).toBe("https://chatgpt.com/backend-api");
		expect(model?.contextWindow).toBe(272000);
		expect(model?.maxTokens).toBe(128000);
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

	for (const definition of managedGatewayAliasDefinitions) {
		it(`includes ${definition.name} models normalized to the gateway endpoint`, () => {
			const model = getModel(definition.id, definition.defaultModel);
			expect(model).toBeTruthy();
			expect(model?.provider).toBe(definition.id);
			expect(model?.api).toBe(expectedManagedGatewayModelAPI(definition));
			expect(model?.baseUrl).toBe(
				expectedManagedGatewayModelBaseURL(definition),
			);
		});
	}

	it("drops managed gateway providers when the kill switch is enabled", () => {
		const path = join(
			tmpdir(),
			`maestro-model-flags-${Date.now()}-${Math.random()}.json`,
		);
		writeFileSync(
			path,
			JSON.stringify({
				flags: [
					{
						key: "platform.kill_switches.maestro.evalops_managed",
						enabled: true,
					},
				],
			}),
		);
		process.env.EVALOPS_FEATURE_FLAGS_PATH = path;
		resetFeatureFlagCacheForTests();

		expect(getProviders()).not.toContain("evalops");
		expect(getModel("evalops", "gpt-4o-mini")).toBeNull();
	});
});
