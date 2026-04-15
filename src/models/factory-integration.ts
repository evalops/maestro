/**
 * Factory Integration
 * Reads and converts Factory config files (~/.factory/) into Composer model configuration.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { getStoredCredentials } from "../agent/keys.js";
import type { Api } from "../agent/types.js";
import { parseJsonOr, safeJsonParse } from "../utils/json.js";
import { createLogger } from "../utils/logger.js";
import { getHomeDir, resolveEnvPath } from "../utils/path-expansion.js";
import {
	type CustomModel,
	type CustomModelConfig,
	type CustomProvider,
	applyProviderLoader,
	readJsonFile,
} from "./config-loader.js";
import { normalizeBaseUrl } from "./url-normalize.js";

const logger = createLogger("models:registry");

export const FACTORY_HOME =
	resolveEnvPath(process.env.FACTORY_HOME) ?? join(getHomeDir(), ".factory");
export const FACTORY_CONFIG_PATH = join(FACTORY_HOME, "config.json");
export const FACTORY_SETTINGS_PATH = join(FACTORY_HOME, "settings.json");
export const FACTORY_KEYS_PATH = join(FACTORY_HOME, "keys.json");

export let factoryDataCache:
	| { config: CustomModelConfig; modelProviderMap: Map<string, string> }
	| null
	| undefined;

export function clearFactoryCache(): void {
	factoryDataCache = undefined;
}

interface FactoryModelEntry {
	model: string;
	model_display_name?: string;
	base_url?: string;
	api_key?: string;
	provider?: string;
	max_tokens?: number;
}

interface FactoryConfigFile {
	custom_models?: FactoryModelEntry[];
	api_keys?: Record<string, string>;
}

const FACTORY_API_MAP: Record<string, Api> = {
	anthropic: "anthropic-messages",
	openai: "openai-responses",
	google: "google-generative-ai",
};

function sanitizeId(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+/, "")
			.replace(/-+$/, "") || "provider"
	);
}

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

function deriveProviderApi(provider?: string): Api {
	if (provider && FACTORY_API_MAP[provider as keyof typeof FACTORY_API_MAP]) {
		return FACTORY_API_MAP[provider as keyof typeof FACTORY_API_MAP]!;
	}
	return "openai-responses";
}

function deriveProviderName(provider?: string, baseUrl?: string): string {
	const base = provider ? capitalize(provider) : "Factory";
	if (!baseUrl) {
		return `Factory ${base}`;
	}
	try {
		const host = new URL(baseUrl).hostname;
		return `Factory ${base} (${host})`;
	} catch {
		return `Factory ${base}`;
	}
}

export function buildFactoryData(): {
	config: CustomModelConfig;
	modelProviderMap: Map<string, string>;
} | null {
	if (!existsSync(FACTORY_CONFIG_PATH)) {
		return null;
	}
	try {
		const raw = readJsonFile(FACTORY_CONFIG_PATH);
		if (!raw) {
			return null;
		}
		const result = safeJsonParse<FactoryConfigFile>(raw, ".factory.json");
		if (!result.success) {
			logger.warn("Failed to parse .factory.json", {
				error: "error" in result ? result.error.message : "Unknown error",
			});
			return null;
		}
		const parsed = result.data;
		if (!parsed.custom_models?.length) {
			return null;
		}
		const factoryKeys = parsed.api_keys ?? {};
		const providers: CustomProvider[] = [];
		const modelProviderMap = new Map<string, string>();
		const providerKeyMap = new Map<string, CustomProvider>();
		const usedIds = new Set<string>();

		for (const entry of parsed.custom_models) {
			if (!entry?.model || !entry.base_url) {
				continue;
			}

			// Normalize provider base URLs using shared function
			const api = deriveProviderApi(entry.provider);
			const normalizedBaseUrl = normalizeBaseUrl(
				entry.base_url,
				entry.provider ?? "factory",
				api,
			);

			const inlineKey = entry.api_key;
			const storedKey =
				factoryKeys[entry.provider ?? "factory"] ??
				getStoredCredentials(entry.provider ?? "factory").apiKey;
			const uniqueKey = `${entry.provider ?? "factory"}|${normalizedBaseUrl}|${inlineKey ?? storedKey ?? ""}`;
			let provider = providerKeyMap.get(uniqueKey);
			if (!provider) {
				const sanitized = sanitizeId(entry.provider ?? "factory");
				let id = `factory-${sanitized}`;
				let counter = 2;
				while (usedIds.has(id)) {
					id = `factory-${sanitized}-${counter++}`;
				}
				usedIds.add(id);
				provider = {
					id,
					name: deriveProviderName(entry.provider, normalizedBaseUrl),
					api: deriveProviderApi(entry.provider),
					baseUrl: normalizedBaseUrl,
					apiKey: inlineKey ?? storedKey,
					models: [],
				};
				providerKeyMap.set(uniqueKey, provider);
				providers.push(provider);
			}
			const maxTokens =
				typeof entry.max_tokens === "number" && entry.max_tokens > 0
					? entry.max_tokens
					: 8192;
			const model: CustomModel = {
				id: entry.model,
				name: entry.model_display_name || entry.model,
				baseUrl: normalizedBaseUrl,
				contextWindow: maxTokens,
				maxTokens,
			};
			provider.models ??= [];
			provider.models.push(model);
			modelProviderMap.set(entry.model, provider.id);
		}

		if (providers.length === 0) {
			return null;
		}

		// Apply provider-specific loaders to Factory providers too
		const enhancedProviders = providers
			.map((provider) =>
				applyProviderLoader(provider, { includeDisabled: true }),
			)
			.filter((provider): provider is CustomProvider => Boolean(provider));

		return {
			config: { providers: enhancedProviders },
			modelProviderMap,
		};
	} catch {
		return null;
	}
}

export function ensureFactoryData(): {
	config: CustomModelConfig;
	modelProviderMap: Map<string, string>;
} | null {
	if (factoryDataCache === undefined) {
		factoryDataCache = buildFactoryData();
	}
	return factoryDataCache ?? null;
}

export function stripJsonComments(input: string): string {
	let insideString = false;
	let previousChar = "";
	let result = "";
	for (let i = 0; i < input.length; i++) {
		const char = input[i]!;
		const next = input[i + 1];
		if (!insideString && char === "/" && next === "/") {
			while (i < input.length && input[i] !== "\n") {
				i++;
			}
			result += "\n";
			continue;
		}
		if (!insideString && char === "/" && next === "*") {
			i += 2;
			while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) {
				i++;
			}
			i++;
			continue;
		}
		if (char === '"' && previousChar !== "\\") {
			insideString = !insideString;
		}
		result += char;
		previousChar = char;
	}
	return result;
}

function readFactorySettingsModel(): string | null {
	const raw = existsSync(FACTORY_SETTINGS_PATH)
		? readJsonFile(FACTORY_SETTINGS_PATH)
		: null;
	if (!raw) {
		return null;
	}
	try {
		const sanitized = stripJsonComments(raw);
		const parsed = parseJsonOr<{ model?: string }>(sanitized, {});
		if (parsed && typeof parsed.model === "string" && parsed.model.trim()) {
			return parsed.model.trim();
		}
		return null;
	} catch {
		return null;
	}
}

export function getFactoryDefaultModelSelection(): {
	provider: string;
	modelId: string;
} | null {
	const selection = readFactorySettingsModel();
	if (!selection) {
		return null;
	}
	const factoryData = ensureFactoryData();
	if (!factoryData) {
		return null;
	}
	const provider = factoryData.modelProviderMap.get(selection);
	if (!provider) {
		return null;
	}
	return { provider, modelId: selection };
}

export function readFactoryConfigSnapshot(): CustomModelConfig | null {
	const data = buildFactoryData();
	if (data) {
		factoryDataCache = data;
	}
	return data?.config ?? null;
}

export function getFactoryConfigPath(): string {
	return FACTORY_CONFIG_PATH;
}

export function getFactorySettingsPath(): string {
	return FACTORY_SETTINGS_PATH;
}
