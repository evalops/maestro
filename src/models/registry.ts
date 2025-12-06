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
 * 2. **User Config**: `~/.composer/models.json` or `~/.composer/models.jsonc`
 * 3. **Project Config**: `.composer/models.json` in current directory
 * 4. **Environment Variable**: `COMPOSER_MODELS_FILE` for custom path
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
 *     "smart": "anthropic/claude-opus-4-5-20251101"
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
 * | anthropic-messages    | Anthropic Messages API                   |
 * | google-generative-ai  | Google Generative AI API                 |
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

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import type { ErrorObject } from "ajv";
import { getStoredCredentials } from "../agent/keys.js";
import type { Api, Model, Provider } from "../agent/types.js";
import { PolicyError, checkModelPolicy } from "../safety/policy.js";
import {
	substituteEnvVars,
	substituteFileRefs,
} from "../utils/config-substitution.js";
import { parseJsonOr, safeJsonParse } from "../utils/json.js";
import {
	type ParseError as JsoncParseError,
	parseJsonc,
	printParseErrorCode,
} from "../utils/jsonc-umd.js";
import { createLogger } from "../utils/logger.js";
import { compileTypeboxSchema } from "../utils/typebox-ajv.js";
import { getModel, getModels, getProviders } from "./builtin.js";
import { normalizeLLMBaseUrl } from "./url-normalize.js";

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

// ─────────────────────────────────────────────────────────────────────────────
// Configuration Schemas (TypeBox)
// These schemas define the structure and validation rules for model configuration
// ─────────────────────────────────────────────────────────────────────────────

/** Optional custom headers to send with API requests */
const headersSchema = Type.Optional(Type.Record(Type.String(), Type.String()));

/**
 * Schema for individual model configuration within a provider.
 *
 * Each model defines its capabilities, limits, and optional overrides
 * for API endpoints and headers.
 */
const modelSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	name: Type.String({ minLength: 1 }),
	api: Type.Optional(
		Type.Union([
			Type.Literal("openai-completions"),
			Type.Literal("openai-responses"),
			Type.Literal("anthropic-messages"),
			Type.Literal("google-generative-ai"),
			Type.Literal("bedrock-converse"),
		]),
	),
	baseUrl: Type.Optional(Type.String({ minLength: 1 })),
	reasoning: Type.Optional(Type.Boolean()),
	input: Type.Optional(
		Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")])),
	),
	cost: Type.Optional(
		Type.Object({
			input: Type.Number({ minimum: 0 }),
			output: Type.Number({ minimum: 0 }),
			cacheRead: Type.Number({ minimum: 0 }),
			cacheWrite: Type.Number({ minimum: 0 }),
		}),
	),
	contextWindow: Type.Number({ minimum: 1 }),
	maxTokens: Type.Number({ minimum: 1 }),
	headers: headersSchema,
});

const providerSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	name: Type.String({ minLength: 1 }),
	api: Type.Optional(modelSchema.properties.api),
	baseUrl: Type.Optional(Type.String({ minLength: 1 })),
	apiKeyEnv: Type.Optional(Type.String({ minLength: 1 })),
	apiKey: Type.Optional(Type.String({ minLength: 1 })),
	enabled: Type.Optional(Type.Boolean({ default: true })),
	options: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	models: Type.Array(modelSchema, { minItems: 1 }),
});

const configSchema = Type.Object({
	$schema: Type.Optional(Type.String()),
	providers: Type.Array(providerSchema, { default: [] }),
	aliases: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description:
				"Model aliases for convenience (e.g., 'fast': 'anthropic/claude-haiku')",
		}),
	),
});

const configValidator = compileTypeboxSchema(configSchema);

export function isLocalBaseUrl(url?: string): boolean {
	if (!url) {
		return false;
	}
	try {
		const parsed = new URL(url);
		return (
			parsed.hostname === "localhost" ||
			parsed.hostname === "127.0.0.1" ||
			parsed.hostname === "::1" ||
			parsed.hostname === "0.0.0.0"
		);
	} catch {
		return false;
	}
}

export type CustomModelConfig = Static<typeof configSchema>;
export type CustomProvider = Static<typeof providerSchema>;
export type CustomModel = Static<typeof modelSchema>;

/**
 * Deep merge two objects (simple implementation for configs)
 */
function mergeDeep<T>(target: T, source: Partial<T>): T {
	const output = { ...target };

	if (isObject(target) && isObject(source)) {
		const sourceRecord = source as Record<string, unknown>;
		const outputRecord = output as Record<string, unknown>;
		for (const key of Object.keys(sourceRecord)) {
			const sourceValue = sourceRecord[key];
			const targetValue = outputRecord[key];

			if (isObject(sourceValue) && isObject(targetValue)) {
				outputRecord[key] = mergeDeep(targetValue, sourceValue);
			} else if (Array.isArray(sourceValue) && Array.isArray(targetValue)) {
				// For arrays, concatenate and dedupe by id if objects have id property
				const merged = [...targetValue];
				for (const item of sourceValue) {
					const itemId =
						isObject(item) && "id" in item
							? (item as { id?: unknown }).id
							: undefined;
					if (itemId !== undefined) {
						const existingIndex = merged.findIndex((entry) => {
							if (isObject(entry) && "id" in entry) {
								return (entry as { id?: unknown }).id === itemId;
							}
							return false;
						});
						if (existingIndex >= 0) {
							// Merge existing item
							merged[existingIndex] = mergeDeep(
								merged[existingIndex] as object,
								item as object,
							) as (typeof targetValue)[number];
						} else {
							merged.push(item as (typeof targetValue)[number]);
						}
					} else {
						merged.push(item as (typeof targetValue)[number]);
					}
				}
				outputRecord[key] = merged as unknown;
			} else {
				outputRecord[key] = sourceValue;
			}
		}
	}

	return output;
}

function isObject(item: unknown): item is Record<string, unknown> {
	return item !== null && typeof item === "object" && !Array.isArray(item);
}

function formatValidationErrors(errors?: ErrorObject[] | null): string {
	if (!errors || errors.length === 0) {
		return "Invalid configuration";
	}
	return errors
		.map(
			(err) => `${err.instancePath || "/"} ${err.message ?? "invalid value"}`,
		)
		.join("; ");
}

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

/**
 * Config file paths in order of precedence (last wins)
 */
const getConfigPaths = (): string[] => {
	const paths: string[] = [];

	// 1. Global config
	paths.push(join(homedir(), ".composer", "config.json"));
	paths.push(join(homedir(), ".composer", "local.json"));

	// 2. Project config (current directory)
	const projectConfig = join(process.cwd(), ".composer", "config.json");
	if (existsSync(projectConfig)) {
		paths.push(projectConfig);
	}
	const projectLocal = join(process.cwd(), ".composer", "local.json");
	if (existsSync(projectLocal)) {
		paths.push(projectLocal);
	}

	// 3. Legacy path for backward compatibility
	const legacyPath = join(homedir(), ".composer", "models.json");
	if (existsSync(legacyPath)) {
		paths.push(legacyPath);
	}

	// 4. Environment variable override
	if (process.env.COMPOSER_MODELS_FILE) {
		paths.push(resolve(process.env.COMPOSER_MODELS_FILE));
	}

	if (process.env.COMPOSER_CONFIG) {
		paths.push(resolve(process.env.COMPOSER_CONFIG));
	}

	return paths;
};

const configPath = (): string =>
	process.env.COMPOSER_MODELS_FILE
		? resolve(process.env.COMPOSER_MODELS_FILE)
		: join(homedir(), ".composer", "models.json");

const FACTORY_HOME = process.env.FACTORY_HOME ?? join(homedir(), ".factory");
const FACTORY_CONFIG_PATH = join(FACTORY_HOME, "config.json");
const FACTORY_SETTINGS_PATH = join(FACTORY_HOME, "settings.json");
const FACTORY_KEYS_PATH = join(FACTORY_HOME, "keys.json");
const COMPOSER_KEYS_PATH = join(homedir(), ".composer", "keys.json");

let cachedConfig: CustomModelConfig | null = null;
let cachedProviders: RegisteredModel[] | null = null;
const customProviderMetadata = new Map<string, ProviderMetadata>();
let factoryDataCache:
	| { config: CustomModelConfig; modelProviderMap: Map<string, string> }
	| null
	| undefined;
const fileSnapshots = new Map<string, { mtimeMs: number; data: string }>();

/**
 * Provider-specific configuration loaders
 * These handle provider-specific initialization, defaults, and auto-detection
 */
interface ProviderLoaderResult {
	headers?: Record<string, string>;
	baseUrl?: string;
	enabled?: boolean;
	options?: Record<string, unknown>;
}

type ProviderLoader = (providerId: string) => ProviderLoaderResult | null;

const PROVIDER_LOADERS: Record<string, ProviderLoader> = {
	anthropic: (providerId: string) => ({
		headers: {
			"anthropic-beta": "prompt-caching-2024-07-31",
		},
	}),

	bedrock: (providerId: string) => {
		const region = process.env.AWS_REGION ?? "us-east-1";
		const hasCredentials = Boolean(
			process.env.AWS_PROFILE ||
				process.env.AWS_ACCESS_KEY_ID ||
				process.env.AWS_BEARER_TOKEN_BEDROCK,
		);

		return {
			baseUrl: `https://bedrock-runtime.${region}.amazonaws.com`,
			enabled: hasCredentials,
			options: { region },
		};
	},

	"vertex-ai": (providerId: string) => {
		const project =
			process.env.GOOGLE_CLOUD_PROJECT ??
			process.env.GCP_PROJECT ??
			process.env.GCLOUD_PROJECT;
		const location =
			process.env.GOOGLE_CLOUD_LOCATION ??
			process.env.VERTEX_LOCATION ??
			"us-east5";

		if (!project) {
			return { enabled: false };
		}

		return {
			enabled: true,
			options: { project, location },
		};
	},
};

/**
 * Apply provider-specific configurations
 */
function applyProviderLoader(
	provider: CustomProvider,
	options?: { includeDisabled?: boolean },
): CustomProvider | null {
	const loader =
		PROVIDER_LOADERS[provider.id] ??
		PROVIDER_LOADERS[provider.id.split("-")[0]]; // Try base name (e.g., "bedrock" from "aws-bedrock")

	if (!loader) {
		return provider;
	}

	const result = loader(provider.id);

	const enhanced: CustomProvider = { ...provider };
	let enabled = provider.enabled ?? true;

	// Merge loader results with provider config
	if (result) {
		if (result.headers) {
			enhanced.models = enhanced.models.map((model) => ({
				...model,
				headers: { ...result.headers, ...model.headers },
			}));
		}

		if (result.baseUrl && !provider.baseUrl) {
			enhanced.baseUrl = result.baseUrl;
		}

		if (result.enabled !== undefined) {
			enabled = result.enabled;
		}

		if (result.options) {
			enhanced.options = { ...result.options, ...enhanced.options };
		}
	}

	enhanced.enabled = enabled;

	if (enabled === false && !options?.includeDisabled) {
		return null;
	}

	return enhanced;
}

/**
 * Parse JSONC (JSON with comments) with helpful error messages
 */
function parseJsoncWithErrors(text: string, filePath: string): unknown {
	const errors: JsoncParseError[] = [];
	const data = parseJsonc(text, errors, {
		allowTrailingComma: true,
		disallowComments: false,
	});

	if (errors.length > 0) {
		const lines = text.split("\n");
		const errorDetails = errors
			.map((e) => {
				const beforeOffset = text.substring(0, e.offset).split("\n");
				const line = beforeOffset.length;
				const column = beforeOffset[beforeOffset.length - 1].length + 1;
				const problemLine = lines[line - 1];

				const error = `${printParseErrorCode(e.error)} at line ${line}, column ${column}`;
				if (!problemLine) return error;

				return `${error}\n   Line ${line}: ${problemLine}\n${"".padStart(column + 9)}^`;
			})
			.join("\n");

		throw new Error(
			`Failed to parse JSONC config at ${filePath}:\n${errorDetails}`,
		);
	}

	return data;
}

function readJsonFile(filePath: string): string | null {
	try {
		const stats = statSync(filePath);
		const cached = fileSnapshots.get(filePath);
		if (cached && cached.mtimeMs === stats.mtimeMs) {
			return cached.data;
		}
		const data = readFileSync(filePath, "utf-8");
		fileSnapshots.set(filePath, { mtimeMs: stats.mtimeMs, data });
		return data;
	} catch {
		fileSnapshots.delete(filePath);
		return null;
	}
}

/**
 * Load and parse a single config file
 */
function loadConfigFile(path: string): CustomModelConfig | null {
	const raw = existsSync(path) ? readJsonFile(path) : null;
	if (!raw) {
		return null;
	}

	try {
		// Process file references first (before env vars, so file contents can have env vars)
		const configDir = dirname(path);
		let processed = substituteFileRefs(raw, configDir);

		// Process environment variable substitution
		processed = substituteEnvVars(processed, logger);

		// Parse JSONC (supports comments and trailing commas)
		const data = parseJsoncWithErrors(processed, path);

		if (!configValidator(data)) {
			throw new Error(formatValidationErrors(configValidator.errors));
		}

		return data as CustomModelConfig;
	} catch (error) {
		throw new Error(
			`Failed to parse config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Load config with hierarchy (global -> project -> env)
 */
function loadConfig(includeDisabled = false): CustomModelConfig {
	if (cachedConfig && !includeDisabled) {
		return cachedConfig;
	}

	// Try loading from hierarchy
	const paths = getConfigPaths();
	let mergedConfig: CustomModelConfig = { providers: [] };

	for (const path of paths) {
		const config = loadConfigFile(path);
		if (config) {
			mergedConfig = mergeDeep(mergedConfig, config);
		}
	}

	// If no configs found, try Factory fallback
	if (mergedConfig.providers.length === 0) {
		const factoryFallback = ensureFactoryData();
		if (factoryFallback) {
			if (!includeDisabled) {
				cachedConfig = factoryFallback.config;
			}
			return factoryFallback.config;
		}
	}

	// Apply provider-specific loaders
	mergedConfig.providers = mergedConfig.providers
		.map((provider) => applyProviderLoader(provider, { includeDisabled }))
		.filter((provider): provider is CustomProvider => Boolean(provider));

	if (!includeDisabled) {
		cachedConfig = mergedConfig;
	}
	return mergedConfig;
}

function validateBaseUrl(baseUrl: string, providerId: string, api?: Api): void {
	// Validate common provider URL patterns
	if (providerId === "anthropic" || api === "anthropic-messages") {
		if (baseUrl.includes("api.anthropic.com")) {
			if (
				!baseUrl.includes("/v1/messages") &&
				!baseUrl.includes("/v1/complete")
			) {
				logger.warn(
					"Anthropic base URL should end with /v1/messages, auto-normalizing",
					{ baseUrl },
				);
			}
		}
	}

	if (providerId.includes("bedrock") || providerId.includes("aws")) {
		if (baseUrl.includes("bedrock.") && !baseUrl.includes("bedrock-runtime.")) {
			logger.warn(
				"AWS Bedrock URL should use 'bedrock-runtime', auto-normalizing",
				{ baseUrl },
			);
		}
	}

	if (providerId.includes("vertex") || providerId.includes("google")) {
		if (
			baseUrl.includes("aiplatform.googleapis.com") &&
			!baseUrl.includes("/v1/")
		) {
			logger.warn("Google Vertex AI URLs should include full path with /v1/", {
				baseUrl,
			});
		}
	}
}

function normalizeBaseUrl(
	baseUrl: string,
	providerId: string,
	api?: Api,
): string {
	let normalized = baseUrl;

	// Validate first (logs warnings)
	validateBaseUrl(baseUrl, providerId, api);

	// AWS Bedrock
	if (providerId.includes("bedrock") || providerId.includes("aws")) {
		if (
			normalized.includes("bedrock") &&
			normalized.includes("amazonaws.com") &&
			!normalized.includes("bedrock-runtime")
		) {
			normalized = normalized.replace("bedrock.", "bedrock-runtime.");
		}
	}

	// Google Vertex AI
	if (providerId.includes("vertex") || providerId.includes("google")) {
		if (
			normalized.includes("aiplatform.googleapis.com") &&
			!normalized.includes("/v1/")
		) {
			normalized = normalized.replace(/\/$/, "");
		}
	}

	// Apply shared Anthropic/OpenAI normalization
	normalized = normalizeLLMBaseUrl(normalized, providerId, api);

	return normalized;
}

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

	return {
		id: model.id,
		name: model.name,
		api,
		provider: provider.id,
		baseUrl,
		reasoning: model.reasoning ?? false,
		input: model.input ?? ["text"],
		cost: model.cost ?? { ...COST_DEFAULT },
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
}

function buildRegistry(): RegisteredModel[] {
	const registry: RegisteredModel[] = [];
	// Built-in
	for (const provider of getProviders()) {
		for (const model of getModels(provider)) {
			registry.push({
				...(model as Model<Api>),
				providerName: provider,
				source: "builtin",
				isLocal: false,
			});
		}
	}
	// Custom
	customProviderMetadata.clear();
	const config = loadConfig();
	for (const provider of config.providers) {
		customProviderMetadata.set(provider.id, {
			id: provider.id,
			name: provider.name,
			apiKey: provider.apiKey,
			apiKeyEnv: provider.apiKeyEnv,
			baseUrl: provider.baseUrl,
		});
		for (const model of provider.models) {
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
	cachedConfig = null;
	cachedProviders = null;
	customProviderMetadata.clear();
	factoryDataCache = undefined;
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
		return FACTORY_API_MAP[provider as keyof typeof FACTORY_API_MAP];
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

function buildFactoryData(): {
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

function ensureFactoryData(): {
	config: CustomModelConfig;
	modelProviderMap: Map<string, string>;
} | null {
	if (factoryDataCache === undefined) {
		factoryDataCache = buildFactoryData();
	}
	return factoryDataCache ?? null;
}

function stripJsonComments(input: string): string {
	let insideString = false;
	let previousChar = "";
	let result = "";
	for (let i = 0; i < input.length; i++) {
		const char = input[i];
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

/**
 * Validate config without loading it (for CLI validation command)
 */
export interface ConfigValidationResult {
	valid: boolean;
	errors: string[];
	warnings: string[];
	summary: {
		configFiles: string[];
		providers: number;
		models: number;
		fileReferences: string[];
		envVars: string[];
	};
}

export function validateConfig(): ConfigValidationResult {
	const result: ConfigValidationResult = {
		valid: true,
		errors: [],
		warnings: [],
		summary: {
			configFiles: [],
			providers: 0,
			models: 0,
			fileReferences: [],
			envVars: [],
		},
	};

	const paths = getConfigPaths();

	// Check each config file
	for (const path of paths) {
		if (!existsSync(path)) {
			continue;
		}

		result.summary.configFiles.push(path);

		try {
			const raw = readFileSync(path, "utf-8");

			// Find file references
			const fileMatches = [...raw.matchAll(/\{file:([^}]+)\}/g)];
			for (const match of fileMatches) {
				let filePath = match[1];
				if (filePath.startsWith("~/")) {
					filePath = join(homedir(), filePath.slice(2));
				} else if (!filePath.startsWith("/")) {
					filePath = join(dirname(path), filePath);
				}

				result.summary.fileReferences.push(filePath);

				if (!existsSync(filePath)) {
					result.errors.push(`File reference not found: ${filePath}`);
					result.valid = false;
				}
			}

			// Find env vars
			const envMatches = [...raw.matchAll(/\{env:([^}]+)\}/g)];
			for (const match of envMatches) {
				const varName = match[1];
				result.summary.envVars.push(varName);

				if (!process.env[varName]) {
					result.warnings.push(`Environment variable not set: ${varName}`);
				}
			}

			// Try parsing
			const config = loadConfigFile(path);
			if (config) {
				result.summary.providers += config.providers.length;
				for (const provider of config.providers) {
					result.summary.models += provider.models.length;
				}
			}
		} catch (error) {
			result.errors.push(
				`Failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
			);
			result.valid = false;
		}
	}

	if (result.summary.configFiles.length === 0) {
		result.warnings.push("No config files found");
	}

	return result;
}

/**
 * Get config info for inspection (for CLI show command)
 */
export interface ConfigInspection {
	sources: Array<{
		path: string;
		exists: boolean;
		loaded: boolean;
	}>;
	providers: Array<{
		id: string;
		name: string;
		baseUrl: string;
		enabled: boolean;
		apiKeySource?: string;
		isLocal: boolean;
		options?: Record<string, unknown>;
		modelCount: number;
		models: Array<{
			id: string;
			name: string;
			reasoning?: boolean;
			input?: string[];
		}>;
	}>;
	fileReferences: Array<{
		path: string;
		exists: boolean;
		size?: number;
	}>;
	envVars: Array<{
		name: string;
		set: boolean;
		maskedValue?: string;
	}>;
}

export function inspectConfig(): ConfigInspection {
	const paths = getConfigPaths();
	const config = loadConfig(true);

	const inspection: ConfigInspection = {
		sources: [],
		providers: [],
		fileReferences: [],
		envVars: [],
	};

	// Track sources
	for (const path of paths) {
		const exists = existsSync(path);
		inspection.sources.push({
			path,
			exists,
			loaded: exists,
		});
	}

	// Track providers
	for (const provider of config.providers) {
		let apiKeySource: string | undefined;

		if (provider.apiKeyEnv) {
			apiKeySource = `env:${provider.apiKeyEnv}`;
		} else if (provider.apiKey) {
			apiKeySource = "direct (hardcoded)";
		}

		const providerBase = provider.baseUrl || "(auto-generated)";
		const local =
			isLocalBaseUrl(provider.baseUrl) ||
			provider.models.some((model) => isLocalBaseUrl(model.baseUrl));
		inspection.providers.push({
			id: provider.id,
			name: provider.name,
			baseUrl: providerBase,
			enabled: provider.enabled !== false,
			apiKeySource,
			isLocal: local,
			options: provider.options,
			modelCount: provider.models.length,
			models: provider.models.map((m) => ({
				id: m.id,
				name: m.name,
				reasoning: m.reasoning,
				input: m.input,
			})),
		});
	}

	// Track file references (scan all config files)
	for (const path of paths) {
		if (!existsSync(path)) continue;

		const raw = readFileSync(path, "utf-8");
		const fileMatches = [...raw.matchAll(/\{file:([^}]+)\}/g)];

		for (const match of fileMatches) {
			let filePath = match[1];
			if (filePath.startsWith("~/")) {
				filePath = join(homedir(), filePath.slice(2));
			} else if (!filePath.startsWith("/")) {
				filePath = join(dirname(path), filePath);
			}

			const exists = existsSync(filePath);
			let size: number | undefined;

			if (exists) {
				try {
					size = statSync(filePath).size;
				} catch {
					// File may have been deleted between existsSync and statSync
				}
			}

			inspection.fileReferences.push({
				path: filePath,
				exists,
				size,
			});
		}
	}

	// Track env vars
	const envVarsSet = new Set<string>();
	for (const path of paths) {
		if (!existsSync(path)) continue;

		const raw = readFileSync(path, "utf-8");
		const envMatches = [...raw.matchAll(/\{env:([^}]+)\}/g)];

		for (const match of envMatches) {
			envVarsSet.add(match[1]);
		}
	}

	for (const provider of config.providers) {
		if (provider.apiKeyEnv) {
			envVarsSet.add(provider.apiKeyEnv);
		}
	}

	for (const varName of envVarsSet) {
		const value = process.env[varName];
		const set = value !== undefined;

		let maskedValue: string | undefined;
		if (set && value) {
			// Mask the value (show first 4 chars)
			maskedValue =
				value.length > 8 ? `${value.slice(0, 4)}${"•".repeat(8)}` : "••••••••";
		}

		inspection.envVars.push({
			name: varName,
			set,
			maskedValue,
		});
	}

	return inspection;
}

/**
 * Get the list of config paths being checked
 */
export function getConfigHierarchy(): string[] {
	return getConfigPaths();
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
	if (parts.length !== 2) {
		logger.warn("Invalid alias target, expected format: provider/modelId", {
			target,
			alias,
		});
		return null;
	}

	return {
		provider: parts[0],
		modelId: parts[1],
	};
}

/**
 * Get all defined aliases
 */
export function getAliases(): Record<string, string> {
	const config = loadConfig();
	return config.aliases || {};
}
