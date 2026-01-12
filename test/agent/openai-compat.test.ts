import { describe, expect, it } from "vitest";
import { resolveOpenAICompatForTest } from "../../src/agent/providers/openai.js";

describe("resolveOpenAICompat", () => {
	const fixtures = [
		{
			name: "OpenAI base URL enables OpenAI-only features",
			model: { baseUrl: "https://api.openai.com/v1", provider: "openai" },
			expect: {
				supportsStore: true,
				supportsDeveloperRole: true,
				supportsReasoningEffort: true,
				supportsResponsesApi: true,
				maxTokensField: "max_completion_tokens",
			},
		},
		{
			name: "Azure OpenAI defaults to OpenAI-compat settings",
			model: {
				baseUrl:
					"https://my-resource.openai.azure.com/openai/deployments/gpt-4/chat/completions?api-version=2024-02-15-preview",
				provider: "azure-openai",
			},
			expect: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				supportsResponsesApi: false,
				maxTokensField: "max_tokens",
			},
		},
		{
			name: "OpenRouter defaults to OpenAI-compat settings",
			model: {
				baseUrl: "https://openrouter.ai/api/v1/chat/completions",
				provider: "openrouter",
			},
			expect: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				supportsResponsesApi: true,
				maxTokensField: "max_tokens",
			},
		},
		{
			name: "Groq defaults to OpenAI-compat settings",
			model: {
				baseUrl: "https://api.groq.com/openai/v1/chat/completions",
				provider: "groq",
			},
			expect: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				supportsResponsesApi: true,
				maxTokensField: "max_tokens",
			},
		},
		{
			name: "Cerebras defaults to OpenAI-compat settings",
			model: {
				baseUrl: "https://api.cerebras.ai/v1/chat/completions",
				provider: "cerebras",
			},
			expect: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				supportsResponsesApi: false,
				maxTokensField: "max_tokens",
			},
		},
		{
			name: "Compat overrides can enable reasoning effort",
			model: {
				baseUrl: "https://api.individual.githubcopilot.com",
				provider: "github-copilot",
				compat: { supportsReasoningEffort: true },
			},
			expect: {
				supportsReasoningEffort: true,
			},
		},
	];

	for (const fixture of fixtures) {
		it(fixture.name, () => {
			const compat = resolveOpenAICompatForTest(
				fixture.model as {
					baseUrl?: string;
					provider?: string;
					compat?: { supportsReasoningEffort?: boolean };
				},
			);
			for (const [key, value] of Object.entries(fixture.expect)) {
				expect(compat[key as keyof typeof compat]).toBe(value);
			}
		});
	}
});
