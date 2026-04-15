import {
	getCustomConfigPath,
	getFactoryConfigPath,
	getFactorySettingsPath,
} from "../models/registry.js";
import {
	countModels,
	loadComposerConfigOrThrow,
	loadFactoryConfigOrThrow,
} from "./config.js";
import { ensureFactorySettings, writeJsonFile } from "./io.js";
import { toFactoryModels } from "./models.js";

export interface FactoryImportResult {
	targetPath: string;
	providerCount: number;
	modelCount: number;
}

export function importFactoryConfig(): FactoryImportResult {
	const factoryConfig = loadFactoryConfigOrThrow();
	const targetPath = getCustomConfigPath();
	writeJsonFile(targetPath, factoryConfig);

	return {
		targetPath,
		providerCount: factoryConfig.providers.length,
		modelCount: countModels(factoryConfig),
	};
}

export interface FactoryExportResult {
	configPath: string;
	settingsPath: string;
	modelCount: number;
	createdSettings: boolean;
}

export function exportFactoryConfig(): FactoryExportResult {
	const composerConfig = loadComposerConfigOrThrow();
	const factoryModels = toFactoryModels(composerConfig);
	if (factoryModels.length === 0) {
		throw new Error(
			"Unable to export to Factory format because no models have baseUrl configured.",
		);
	}

	const configPath = getFactoryConfigPath();
	writeJsonFile(configPath, { custom_models: factoryModels });

	const defaultModel = factoryModels[0]?.model ?? "claude-sonnet-4-5";
	const settingsPath = getFactorySettingsPath();
	const { created } = ensureFactorySettings(settingsPath, defaultModel);

	return {
		configPath,
		settingsPath,
		modelCount: factoryModels.length,
		createdSettings: created,
	};
}
