import type { CustomModelConfig } from "../models/registry.js";
import {
	getComposerCustomConfig,
	readFactoryConfigSnapshot,
} from "../models/registry.js";

export function loadFactoryConfigOrThrow(): CustomModelConfig {
	const factoryConfig = readFactoryConfigSnapshot();
	if (!factoryConfig || factoryConfig.providers.length === 0) {
		throw new Error(
			"Factory configuration not found or contains no custom models. Make sure ~/.factory/config.json exists.",
		);
	}
	return factoryConfig;
}

export function loadComposerConfigOrThrow(): CustomModelConfig {
	const composerConfig = getComposerCustomConfig();
	if (composerConfig.providers.length === 0) {
		throw new Error(
			"Composer configuration has no custom models. Run npm run factory:import or create ~/.composer/models.json first.",
		);
	}
	return composerConfig;
}

export function countModels(config: CustomModelConfig): number {
	return config.providers.reduce(
		(total, provider) => total + (provider.models?.length ?? 0),
		0,
	);
}
