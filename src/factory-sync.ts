import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { CustomModelConfig } from "./models/registry.js";
import {
	getComposerCustomConfig,
	getCustomConfigPath,
	getFactoryConfigPath,
	getFactorySettingsPath,
	readFactoryConfigSnapshot,
} from "./models/registry.js";

interface FactoryModel {
	model: string;
	model_display_name: string;
	base_url: string;
	api_key?: string;
	provider?: string;
	max_tokens: number;
}

const FACTORY_SETTINGS_TEMPLATE = (defaultModel: string): string => `// Factory CLI Settings
// This file contains your Factory CLI configuration.
{
  "model": "${defaultModel}",
  "reasoningEffort": "medium",
  "cloudSessionSync": true,
  "diffMode": "github",
  "ideExtensionPromptedAt": {},
  "autonomyMode": "auto-high",
  "ideActivationNudgedForVersion": {},
  "enableCompletionBell": false,
  "completionSound": "fx-ack01",
  "completionSoundFocusMode": "always",
  "commandAllowlist": [
    "ls",
    "pwd",
    "dir"
  ],
  "commandDenylist": [
    "rm -rf /",
    "rm -rf /*",
    "rm -rf .",
    "rm -rf ~",
    "rm -rf ~/*",
    "rm -rf $HOME",
    "rm -r /",
    "rm -r /*",
    "rm -r ~",
    "rm -r ~/*",
    "mkfs",
    "mkfs.ext4",
    "mkfs.ext3",
    "mkfs.vfat",
    "mkfs.ntfs",
    "dd if=/dev/zero of=/dev",
    "dd of=/dev",
    "shutdown",
    "reboot",
    "halt",
    "poweroff",
    "init 0",
    "init 6",
    ":(){ :|: & };:",
    ":() { :|:& };:",
    "chmod -R 777 /",
    "chmod -R 000 /",
    "chown -R",
    "format",
    "powershell Remove-Item -Recurse -Force"
  ],
  "enableCustomDroids": true,
  "enableHooks": false,
  "includeCoAuthoredByDroid": false,
  "enableDroidShield": false,
  "enableReadinessReport": false,
  "todoDisplayMode": "pinned",
  "autonomyLevel": "auto-high"
}
`;

function ensureDir(path: string): void {
	mkdirSync(dirname(path), { recursive: true });
}

function countModels(config: CustomModelConfig): number {
	return config.providers.reduce(
		(total, provider) => total + provider.models.length,
		0,
	);
}

export interface FactoryImportResult {
	targetPath: string;
	providerCount: number;
	modelCount: number;
}

export function importFactoryConfig(): FactoryImportResult {
	const factoryConfig = readFactoryConfigSnapshot();
	if (!factoryConfig || factoryConfig.providers.length === 0) {
		throw new Error(
			"Factory configuration not found or contains no custom models. Make sure ~/.factory/config.json exists.",
		);
	}

	const targetPath = getCustomConfigPath();
	ensureDir(targetPath);
	writeFileSync(targetPath, JSON.stringify(factoryConfig, null, 2), "utf-8");

	return {
		targetPath,
		providerCount: factoryConfig.providers.length,
		modelCount: countModels(factoryConfig),
	};
}

function toFactoryModels(config: CustomModelConfig): FactoryModel[] {
	const models: FactoryModel[] = [];
	for (const provider of config.providers) {
		for (const model of provider.models) {
			const baseUrl = model.baseUrl ?? provider.baseUrl;
			if (!baseUrl) {
				continue;
			}
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

export interface FactoryExportResult {
	configPath: string;
	settingsPath: string;
	modelCount: number;
	createdSettings: boolean;
}

export function exportFactoryConfig(): FactoryExportResult {
	const composerConfig = getComposerCustomConfig();
	if (composerConfig.providers.length === 0) {
		throw new Error(
			"Composer configuration has no custom models. Run npm run factory:import or create ~/.composer/models.json first.",
		);
	}

	const factoryModels = toFactoryModels(composerConfig);
	if (factoryModels.length === 0) {
		throw new Error(
			"Unable to export to Factory format because no models have baseUrl configured.",
		);
	}

	const configPath = getFactoryConfigPath();
	ensureDir(configPath);
	writeFileSync(
		configPath,
		JSON.stringify({ custom_models: factoryModels }, null, 2),
		"utf-8",
	);

	const defaultModel = factoryModels[0]?.model ?? "claude-sonnet-4-5";
	const settingsPath = getFactorySettingsPath();
	const hadSettings = existsSync(settingsPath);
	if (!hadSettings) {
		ensureDir(settingsPath);
		writeFileSync(settingsPath, FACTORY_SETTINGS_TEMPLATE(defaultModel), "utf-8");
	}

	return {
		configPath,
		settingsPath,
		modelCount: factoryModels.length,
		createdSettings: !hadSettings,
	};
}
