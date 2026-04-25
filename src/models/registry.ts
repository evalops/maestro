/**
 * Model Registry - Provider and Model Configuration
 *
 * This module manages the registration, validation, and resolution of LLM
 * models and providers. It supports both built-in models and custom user
 * configurations, with schema validation and policy enforcement.
 *
 * ## Configuration Hierarchy
 *
 * Model configuration is loaded from multiple sources with the following
 * priority (later sources override earlier ones):
 *
 * 1. **Built-in Models**: Hardcoded in `src/models/builtin.ts`
 * 2. **User Config**: `~/.maestro/models.json` or `~/.maestro/models.jsonc`
 * 3. **Project Config**: `.maestro/models.json` in current directory
 * 4. **Environment Variable**: `MAESTRO_MODELS_FILE` for custom path
 * 5. **CLI Flag**: `--models-file` for runtime override
 *
 * ## Configuration Format
 *
 * ```jsonc
 * {
 *   "$schema": "https://example.com/models.schema.json",
 *   "providers": [
 *     {
 *       "id": "my-provider",
 *       "name": "My Local LLM",
 *       "api": "openai-completions",
 *       "baseUrl": "http://localhost:8080/v1",
 *       "apiKeyEnv": "MY_API_KEY",
 *       "models": [
 *         {
 *           "id": "local-model",
 *           "name": "Local Model 7B",
 *           "contextWindow": 8192,
 *           "maxTokens": 4096
 *         }
 *       ]
 *     }
 *   ],
 *   "aliases": {
 *     "fast": "anthropic/claude-3-5-haiku-latest",
 *     "smart": "anthropic/claude-opus-4-6"
 *   }
 * }
 * ```
 *
 * ## Supported APIs
 *
 * | API                   | Description                              |
 * |-----------------------|------------------------------------------|
 * | openai-completions    | OpenAI Chat Completions API              |
 * | openai-responses      | OpenAI Responses API (newer)             |
 * | openai-codex-responses| ChatGPT Codex Responses backend          |
 * | anthropic-messages    | Anthropic Messages API                   |
 * | google-generative-ai  | Google Generative AI API                 |
 * | google-gemini-cli     | Google Cloud Code Assist (Gemini CLI)    |
 *
 * ## Model Resolution
 *
 * When resolving a model by `provider/modelId`:
 *
 * 1. Check alias mappings first
 * 2. Look up in registered models (custom + built-in)
 * 3. Validate against enterprise policy if applicable
 * 4. Return resolved model configuration or error
 *
 * ## Policy Enforcement
 *
 * Enterprise deployments can restrict available models via policy.
 * The `checkModelPolicy()` function validates model access and throws
 * `PolicyError` if the model is not allowed.
 *
 * @module models/registry
 */

import type { Api, Model, Provider } from "../agent/types.js";
import { PolicyError, checkModelPolicy } from "../safety/policy.js";
import { createLogger } from "../utils/logger.js";
import { getModels, getProviders } from "./builtin.js";
import {
	type CustomModel,
	type CustomModelConfig,
	type CustomProvider,
	clearCachedConfig,
	configPath,
	fileSnapshots,
	loadConfig as loadConfigRaw,
	mergeHeaders,
} from "./config-loader.js";
import {
	FACTORY_CONFIG_PATH,
	FACTORY_SETTINGS_PATH,
	clearFactoryCache,
	ensureFactoryData,
} from "./factory-integration.js";
import { isLocalBaseUrl, normalizeBaseUrl } from "./url-normalize.js";

// Re-export types and functions from extracted modules for backward compatibility
export type {
	CustomModelConfig,
	CustomProvider,
	CustomModel,
} from "./config-loader.js";
export type {
	ConfigValidationResult,
	ConfigInspection,
} from "./config-inspection.js";
export {
	validateConfig,
	inspectConfig,
	getConfigHierarchy,
} from "./config-inspection.js";
export {
	getFactoryDefaultModelSelection,
	readFactoryConfigSnapshot,
	getFactoryConfigPath,
	getFactorySettingsPath,
} from "./factory-integration.js";
export { isLocalBaseUrl, normalizeBaseUrl } from "./url-normalize.js";
const logger = createLogger("models:registry");

/**
 * Default cost values for models without pricing information.
 * All costs are in USD per 1M tokens.
 */
const COST_DEFAULT = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
} as const;

export interface RegisteredModel extends Model<Api> {
	providerName: string;
	source: "builtin" | "custom";
	isLocal: boolean;
}

export interface ProviderMetadata {
	id: string;
	name: string;
	apiKey?: string;
	apiKeyEnv?: string;
	baseUrl?: string;
}

let cachedProviders: RegisteredModel[] | null = null;
const customProviderMetadata = new Map<string, ProviderMetadata>();

function getExpectedUrlFormat(providerId: string, api?: Api): string {
	if (providerId === "anthropic" || api === "anthropic-messages") {
		return "https://api.anthropic.com/v1/messages";
	}
	if (providerId.includes("bedrock") || providerId.includes("aws")) {
		return "https://bedrock-runtime.{region}.amazonaws.com (e.g., bedrock-runtime.us-east-1.amazonaws.com)";
	}
	if (providerId.includes("vertex") || providerId.includes("google")) {
		return "https://{region}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/anthropic/models/{model}:rawPredict";
	}
	if (providerId === "openai") {
		return "https://api.openai.com/v1/chat/completions";
	}
	return "A valid API endpoint URL";
}

function toModel(provider: CustomProvider, model: CustomModel): Model<Api> {
	const api = model.api ?? provider.api;
	let baseUrl = model.baseUrl ?? provider.baseUrl;
	if (!api || !baseUrl) {
		const expectedFormat = getExpectedUrlFormat(provider.id, api);
		throw new Error(
			`Model ${provider.id}/${model.id} is missing api or baseUrl.\n` +
				`Expected format: ${expectedFormat}\n` +
				`Specify them either on the model or provider entry in ${configPath()}.`,
		);
	}

	// Normalize the base URL
	baseUrl = normalizeBaseUrl(baseUrl, provider.id, api);
	const headers = mergeHeaders(provider.headers, model.headers);

	return {
		id: model.id,
		name: model.name,
		api,
		provider: provider.id,
		baseUrl,
		headers,
		reasoning: model.reasoning ?? false,
		input: model.input ?? ["text"],
		cost: model.cost ?? { ...COST_DEFAULT },
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		compat: model.compat,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Config Loading (delegates to config-loader)
// ─────────────────────────────────────────────────────────────────────────────

function loadConfig(includeDisabled = false): CustomModelConfig {
	return loadConfigRaw(includeDisabled, ensureFactoryData);
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

interface ProviderOverride {
	baseUrl?: string;
	headers?: Record<string, string>;
}

function getProviderOverrides(
	config: CustomModelConfig,
): Map<string, ProviderOverride> {
	const overrides = new Map<string, ProviderOverride>();

	for (const provider of config.providers) {
		const models = provider.models ?? [];
		if (models.length > 0) {
			continue;
		}
		if (provider.baseUrl || provider.headers) {
			overrides.set(provider.id, {
				baseUrl: provider.baseUrl,
				headers: provider.headers,
			});
		}
	}

	return overrides;
}

function buildRegistry(): RegisteredModel[] {
	const registry: RegisteredModel[] = [];
	const config = loadConfig();
	const overrides = getProviderOverrides(config);
	// Built-in
	for (const provider of getProviders()) {
		const override = overrides.get(provider);
		for (const model of getModels(provider)) {
			const baseUrl = override?.baseUrl
				? normalizeBaseUrl(override.baseUrl, provider, model.api)
				: model.baseUrl;
			const headers = mergeHeaders(model.headers, override?.headers);
			registry.push({
				...(model as Model<Api>),
				baseUrl,
				headers,
				providerName: provider,
				source: "builtin",
				isLocal: isLocalBaseUrl(baseUrl),
			});
		}
	}
	// Custom
	customProviderMetadata.clear();
	for (const provider of config.providers) {
		customProviderMetadata.set(provider.id, {
			id: provider.id,
			name: provider.name,
			apiKey: provider.apiKey,
			apiKeyEnv: provider.apiKeyEnv,
			baseUrl: provider.baseUrl,
		});
		const models = provider.models ?? [];
		for (const model of models) {
			const resolved = toModel(provider, model);
			const modelBaseUrl = model.baseUrl ?? provider.baseUrl;
			registry.push({
				...resolved,
				providerName: provider.name,
				source: "custom",
				isLocal: isLocalBaseUrl(modelBaseUrl),
			});
		}
	}
	return registry;
}

export function getRegisteredModels(): RegisteredModel[] {
	if (!cachedProviders) {
		cachedProviders = buildRegistry();
	}
	return cachedProviders;
}

export function reloadModelConfig(): void {
	clearCachedConfig();
	cachedProviders = null;
	customProviderMetadata.clear();
	clearFactoryCache();
	fileSnapshots.delete(configPath());
	fileSnapshots.delete(FACTORY_CONFIG_PATH);
	fileSnapshots.delete(FACTORY_SETTINGS_PATH);
	loadConfig();
	getRegisteredModels();
}

export function resolveModel(
	provider: Provider,
	modelId: string,
): Model<Api> | null {
	const match = getRegisteredModels().find(
		(entry) => entry.provider === provider && entry.id === modelId,
	);
	if (!match) return null;

	// Check enterprise policy
	const policyResult = checkModelPolicy(modelId);
	if (!policyResult.allowed) {
		// Throw policy error instead of returning null to distinguish from "not found"
		throw new PolicyError(
			`Model "${modelId}" is blocked by enterprise policy: ${policyResult.reason}`,
		);
	}

	return match;
}

/**
 * Find a model by ID across all providers (provider-agnostic lookup).
 * Returns the first match found, or null if not found.
 */
export function findModelById(modelId: string): Model<Api> | null {
	const match = getRegisteredModels().find((entry) => entry.id === modelId);
	if (!match) return null;

	// Check enterprise policy
	const policyResult = checkModelPolicy(modelId);
	if (!policyResult.allowed) {
		throw new PolicyError(
			`Model "${modelId}" is blocked by enterprise policy: ${policyResult.reason}`,
		);
	}

	return match;
}

export function getSupportedProviders(): string[] {
	const builtins = getProviders();
	const custom = loadConfig().providers.map((p) => p.id);
	return Array.from(new Set([...builtins, ...custom]));
}

export function getCustomProviderMetadata(
	provider: string,
): ProviderMetadata | undefined {
	if (!customProviderMetadata.has(provider)) {
		// ensure cache populated
		getRegisteredModels();
	}
	return customProviderMetadata.get(provider);
}

export function getCustomConfigPath(): string {
	return configPath();
}

export function getComposerCustomConfig(): CustomModelConfig {
	return loadConfig();
}

/**
 * Resolve a model alias to provider/modelId
 * Returns null if not an alias or alias not found
 */
export function resolveAlias(
	alias: string,
): { provider: string; modelId: string } | null {
	const config = loadConfig();

	if (!config.aliases) {
		return null;
	}

	const target = config.aliases[alias];
	if (!target) {
		return null;
	}

	// Parse format: "provider/modelId"
	const parts = target.split("/");
	const provider = parts[0];
	const modelId = parts[1];
	if (parts.length !== 2 || !provider || !modelId) {
		logger.warn("Invalid alias target, expected format: provider/modelId", {
			target,
			alias,
		});
		return null;
	}

	return {
		provider,
		modelId,
	};
}

/**
 * Get all defined aliases
 */
export function getAliases(): Record<string, string> {
	const config = loadConfig();
	return config.aliases || {};
}
