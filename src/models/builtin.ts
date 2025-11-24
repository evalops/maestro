import type { Api, Model } from "../agent/types.js";
import { MODELS as GENERATED_MODELS } from "./models.generated.js";
import { normalizeModelBaseUrl } from "./url-normalize.js";

// Manual overlay for OpenRouter Responses models (currently not emitted by generator)
const OPENROUTER_RESPONSES_OVERLAY = {
	openrouter: {
		"openai/o4-mini": {
			id: "openai/o4-mini",
			name: "OpenAI O4 Mini (Responses)",
			api: "openai-responses",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1/responses",
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 200000,
			maxTokens: 32000,
		} as Model<"openai-responses">,
		"openai/o4": {
			id: "openai/o4",
			name: "OpenAI O4 (Responses)",
			api: "openai-responses",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1/responses",
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 200000,
			maxTokens: 64000,
		} as Model<"openai-responses">,
		"openai/o4-mini:online": {
			id: "openai/o4-mini:online",
			name: "OpenAI O4 Mini Online (Responses)",
			api: "openai-responses",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1/responses",
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 200000,
			maxTokens: 32000,
		} as Model<"openai-responses">,
		"openai/o4:online": {
			id: "openai/o4:online",
			name: "OpenAI O4 Online (Responses)",
			api: "openai-responses",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1/responses",
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 200000,
			maxTokens: 64000,
		} as Model<"openai-responses">,
	},
} satisfies Record<string, Record<string, Model<Api>>>;

// Manual overlay for OpenAI Codex Responses models
const OPENAI_CODEX_OVERLAY = {
	openai: {
		"gpt-5.1-codex-max": {
			id: "gpt-5.1-codex-max",
			name: "GPT-5.1 Codex Max",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1/responses",
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 64000,
		} as Model<"openai-responses">,
		"gpt-5.1-codex-mini": {
			id: "gpt-5.1-codex-mini",
			name: "GPT-5.1 Codex Mini",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1/responses",
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 32000,
		} as Model<"openai-responses">,
		"gpt-5-codex-mini": {
			id: "gpt-5-codex-mini",
			name: "GPT-5 Codex Mini",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1/responses",
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 32000,
		} as Model<"openai-responses">,
		"gpt-5.1-codex": {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1/responses",
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 32000,
		} as Model<"openai-responses">,
	},
} satisfies Record<string, Record<string, Model<Api>>>;

// Manual overlay for Groq Responses models
const GROQ_RESPONSES_OVERLAY = {
	groq: {
		"openai/gpt-oss-20b": {
			id: "openai/gpt-oss-20b",
			name: "GPT-OSS 20B (Groq Responses)",
			api: "openai-responses",
			provider: "groq",
			baseUrl: "https://api.groq.com/openai/v1",
			reasoning: false,
			toolUse: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 32000,
		} as Model<"openai-responses">,
		"openai/gpt-oss-120b": {
			id: "openai/gpt-oss-120b",
			name: "GPT-OSS 120B (Groq Responses)",
			api: "openai-responses",
			provider: "groq",
			baseUrl: "https://api.groq.com/openai/v1",
			reasoning: false,
			toolUse: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 64000,
		} as Model<"openai-responses">,
	},
} satisfies Record<string, Record<string, Model<Api>>>;

// Convert generated models to our format
function convertGeneratedModels(): Record<string, Model<Api>[]> {
	const converted: Record<string, Model<Api>[]> = {};

	// Start with generated models
	for (const [provider, models] of Object.entries(GENERATED_MODELS)) {
		converted[provider] = Object.values(models).map((model) => ({
			...model,
			// Ensure baseUrl format consistency across providers
			baseUrl: normalizeModelBaseUrl(model),
		}));
	}

	// Apply overlay additions
	for (const [provider, models] of Object.entries(
		OPENROUTER_RESPONSES_OVERLAY,
	)) {
		if (!converted[provider]) {
			converted[provider] = [];
		}
		for (const model of Object.values(models)) {
			converted[provider] = converted[provider].filter(
				(m) => m.id !== model.id,
			);
			converted[provider].push({
				...model,
				baseUrl: normalizeModelBaseUrl(model),
			});
		}
	}

	for (const [provider, models] of Object.entries(OPENAI_CODEX_OVERLAY)) {
		if (!converted[provider]) {
			converted[provider] = [];
		}
		for (const model of Object.values(models)) {
			converted[provider] = converted[provider].filter(
				(m) => m.id !== model.id,
			);
			converted[provider].push({
				...model,
				baseUrl: normalizeModelBaseUrl(model),
			});
		}
	}

	for (const [provider, models] of Object.entries(GROQ_RESPONSES_OVERLAY)) {
		if (!converted[provider]) {
			converted[provider] = [];
		}
		for (const model of Object.values(models)) {
			converted[provider] = converted[provider].filter(
				(m) => m.id !== model.id,
			);
			converted[provider].push({
				...model,
				baseUrl: normalizeModelBaseUrl(model),
			});
		}
	}

	return converted;
}

// Get all models from generated registry
const BUILTIN_MODELS = convertGeneratedModels();

export function getProviders(): string[] {
	return Object.keys(BUILTIN_MODELS);
}

export function getModels(provider: string): Model<Api>[] {
	return BUILTIN_MODELS[provider] || [];
}

export function getModel(provider: string, modelId: string): Model<Api> | null {
	const models = getModels(provider);
	return models.find((m) => m.id === modelId) || null;
}
