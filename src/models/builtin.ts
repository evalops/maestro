import type { Api, Model } from "../agent/types.js";
import { MODELS as GENERATED_MODELS } from "./models.generated.js";
import { normalizeModelBaseUrl } from "./url-normalize.js";

// Manual overlay for Claude Opus 4.5 (not yet in models.dev registry)
const ANTHROPIC_OPUS_45_OVERLAY = {
	anthropic: {
		"claude-opus-4-5-20251101": {
			id: "claude-opus-4-5-20251101",
			name: "Claude Opus 4.5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: {
				input: 5,
				output: 25,
				cacheRead: 0.5,
				cacheWrite: 6.25,
			},
			contextWindow: 200000,
			maxTokens: 32000,
		} as Model<"anthropic-messages">,
	},
} satisfies Record<string, Record<string, Model<Api>>>;

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

// Manual overlay for OpenAI GPT-5.1 Codex Max (frontier agentic coding model)
// Only available via Responses API - optimized for long-horizon agentic coding
const OPENAI_CODEX_OVERLAY = {
	openai: {
		"gpt-5.1-codex-max": {
			id: "gpt-5.1-codex-max",
			name: "GPT-5.1 Codex Max",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com",
			reasoning: true,
			toolUse: true,
			input: ["text", "image"],
			cost: {
				input: 1.25,
				output: 10,
				cacheRead: 0.125,
				cacheWrite: 0,
			},
			contextWindow: 400000,
			maxTokens: 128000,
		} as Model<"openai-responses">,
	},
} satisfies Record<string, Record<string, Model<Api>>>;

// Cached converted models (built lazily on first access)
let BUILTIN_MODELS: Record<string, Model<Api>[]> | null = null;
const CODEX_MODEL_PATTERN = /codex/i;

/**
 * Convert generated models to our format (called lazily on first access)
 */
function convertGeneratedModels(): Record<string, Model<Api>[]> {
	const converted: Record<string, Model<Api>[]> = {};

	// Start with generated models
	for (const [provider, models] of Object.entries(GENERATED_MODELS)) {
		converted[provider] = Object.values(models)
			.filter((model) => !CODEX_MODEL_PATTERN.test(model.id))
			.map((model) => ({
				...model,
				// Ensure baseUrl format consistency across providers
				baseUrl: normalizeModelBaseUrl(model),
			}));
	}

	// Apply overlay additions
	const overlays: Record<string, Record<string, Model<Api>>>[] = [
		ANTHROPIC_OPUS_45_OVERLAY,
		OPENROUTER_RESPONSES_OVERLAY,
		GROQ_RESPONSES_OVERLAY,
		OPENAI_CODEX_OVERLAY,
	];

	for (const overlay of overlays) {
		for (const [provider, models] of Object.entries(overlay)) {
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
	}

	return converted;
}

/**
 * Ensure models are converted (call this early in app startup for predictable timing)
 * The import is static, but conversion is deferred until first access.
 */
export async function ensureModelsLoaded(): Promise<void> {
	if (BUILTIN_MODELS !== null) return;
	BUILTIN_MODELS = convertGeneratedModels();
}

/**
 * Check if models have been converted
 */
export function areModelsLoaded(): boolean {
	return BUILTIN_MODELS !== null;
}

/**
 * Get models, converting them lazily if needed
 */
function getBuiltinModels(): Record<string, Model<Api>[]> {
	if (BUILTIN_MODELS === null) {
		BUILTIN_MODELS = convertGeneratedModels();
	}
	return BUILTIN_MODELS;
}

export function getProviders(): string[] {
	return Object.keys(getBuiltinModels());
}

export function getModels(provider: string): Model<Api>[] {
	return getBuiltinModels()[provider] || [];
}

export function getModel(provider: string, modelId: string): Model<Api> | null {
	const models = getModels(provider);
	return models.find((m) => m.id === modelId) || null;
}
