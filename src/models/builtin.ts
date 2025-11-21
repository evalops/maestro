import type { Api, Model } from "../agent/types.js";
import { MODELS as GENERATED_MODELS } from "./models.generated.js";

// Convert generated models to our format
function convertGeneratedModels(): Record<string, Model<Api>[]> {
	const converted: Record<string, Model<Api>[]> = {};

	for (const [provider, models] of Object.entries(GENERATED_MODELS)) {
		converted[provider] = Object.values(models).map((model) => ({
			...model,
			// Ensure baseUrl format consistency for Anthropic
			baseUrl:
				model.provider === "anthropic" &&
				!model.baseUrl.includes("/v1/messages")
					? `${model.baseUrl}/v1/messages`
					: model.baseUrl,
		}));
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
