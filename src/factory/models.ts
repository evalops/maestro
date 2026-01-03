import type { CustomModelConfig } from "../models/registry.js";

export interface FactoryModel {
	model: string;
	model_display_name: string;
	base_url: string;
	api_key?: string;
	provider?: string;
	max_tokens: number;
}

export function toFactoryModels(config: CustomModelConfig): FactoryModel[] {
	const models: FactoryModel[] = [];
	for (const provider of config.providers) {
		const providerModels = provider.models ?? [];
		for (const model of providerModels) {
			const baseUrl = model.baseUrl ?? provider.baseUrl;
			if (!baseUrl) continue;
			models.push({
				model: model.id,
				model_display_name: model.name,
				base_url: baseUrl,
				api_key: provider.apiKey,
				provider: provider.id,
				max_tokens: model.maxTokens,
			});
		}
	}
	return models;
}
