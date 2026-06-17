/**
 * Model Configuration Loader
 * Schema definitions, file loading, parsing, and merging for model configs.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import type { ErrorObject } from "ajv";
import { PATHS } from "../config/constants.js";
import { hasAwsCredentials } from "../providers/aws-auth.js";
import {
	substituteEnvVars,
	substituteFileRefs,
} from "../utils/config-substitution.js";
import {
	type ParseError as JsoncParseError,
	parseJsonc,
	printParseErrorCode,
} from "../utils/jsonc-umd.js";
import { createLogger } from "../utils/logger.js";
import { resolveEnvPath } from "../utils/path-expansion.js";
import { sanitizeWithStaticMask } from "../utils/secret-redactor.js";
import { compileTypeboxSchema } from "../utils/typebox-ajv.js";
import {
	type CustomModelUrlPolicyConfig,
	urlMatchesStrictPrefix,
	validateCustomModelConfigUrls,
} from "./url-policy.js";

const logger = createLogger("models:registry");

// ─────────────────────────────────────────────────────────────────────────────
// Configuration Schemas (TypeBox)
// ─────────────────────────────────────────────────────────────────────────────

/** Optional custom headers to send with API requests */
const headersSchema = Type.Optional(Type.Record(Type.String(), Type.String()));
const compatSchema = Type.Optional(
	Type.Object({
		supportsStore: Type.Optional(Type.Boolean()),
		supportsDeveloperRole: Type.Optional(Type.Boolean()),
		supportsReasoningEffort: Type.Optional(Type.Boolean()),
		supportsResponsesApi: Type.Optional(Type.Boolean()),
		maxTokensField: Type.Optional(
			Type.Union([
				Type.Literal("max_tokens"),
				Type.Literal("max_completion_tokens"),
			]),
		),
		requiresToolResultName: Type.Optional(Type.Boolean()),
		requiresAssistantAfterToolResult: Type.Optional(Type.Boolean()),
		requiresThinkingAsText: Type.Optional(Type.Boolean()),
		requiresMistralToolIds: Type.Optional(Type.Boolean()),
	}),
);

/**
 * Schema for individual model configuration within a provider.
 */
export const modelSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	name: Type.String({ minLength: 1 }),
	api: Type.Optional(
		Type.Union([
			Type.Literal("openai-completions"),
			Type.Literal("openai-responses"),
			Type.Literal("openai-codex-responses"),
			Type.Literal("openai-codex-app-server"),
			Type.Literal("anthropic-messages"),
			Type.Literal("google-generative-ai"),
			Type.Literal("google-gemini-cli"),
			Type.Literal("bedrock-converse"),
			Type.Literal("vertex-ai"),
			Type.Literal("scripted-replay"),
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
	compat: compatSchema,
});

export const providerSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	name: Type.String({ minLength: 1 }),
	api: Type.Optional(modelSchema.properties.api),
	baseUrl: Type.Optional(Type.String({ minLength: 1 })),
	headers: headersSchema,
	apiKeyEnv: Type.Optional(Type.String({ minLength: 1 })),
	apiKey: Type.Optional(Type.String({ minLength: 1 })),
	enabled: Type.Optional(Type.Boolean({ default: true })),
	options: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	models: Type.Optional(Type.Array(modelSchema)),
});

export const configSchema = Type.Object({
	$schema: Type.Optional(Type.String()),
	allowedBaseUrls: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	internalBaseUrlAllowList: Type.Optional(
		Type.Array(Type.String({ minLength: 1 })),
	),
	providers: Type.Array(providerSchema, { default: [] }),
	aliases: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description:
				"Model aliases for convenience (e.g., 'fast': 'anthropic/claude-haiku')",
		}),
	),
});

export const configValidator = compileTypeboxSchema(configSchema);

export type CustomModelConfig = Static<typeof configSchema>;
export type CustomProvider = Static<typeof providerSchema>;
export type CustomModel = Static<typeof modelSchema>;

export type ConfigPathScope = "global" | "project" | "legacy" | "env";

export interface ConfigPathEntry {
	path: string;
	scope: ConfigPathScope;
	trusted: boolean;
}

const TRUST_PROJECT_MODEL_CONFIG_ENV = "MAESTRO_TRUST_PROJECT_MODEL_CONFIG";
const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProjectModelConfigTrusted(): boolean {
	const value = process.env[TRUST_PROJECT_MODEL_CONFIG_ENV];
	return value !== undefined && TRUE_ENV_VALUES.has(value.toLowerCase());
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider Loaders
// ─────────────────────────────────────────────────────────────────────────────

interface ProviderLoaderResult {
	headers?: Record<string, string>;
	baseUrl?: string;
	enabled?: boolean;
	options?: Record<string, unknown>;
}

type ProviderLoader = (providerId: string) => ProviderLoaderResult | null;

export const PROVIDER_LOADERS: Record<string, ProviderLoader> = {
	anthropic: (_providerId: string) => ({
		headers: {
			"anthropic-beta": "prompt-caching-2024-07-31",
		},
	}),

	bedrock: (_providerId: string) => {
		const region = process.env.AWS_REGION ?? "us-east-1";

		return {
			baseUrl: `https://bedrock-runtime.${region}.amazonaws.com`,
			enabled: hasAwsCredentials(),
			options: { region },
		};
	},

	"vertex-ai": (_providerId: string) => {
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

// ─────────────────────────────────────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────────────────────────────────────

export function mergeDeep<T>(target: T, source: Partial<T>): T {
	const output = { ...target };

	if (isObject(target) && isObject(source)) {
		const sourceRecord = source as Record<string, unknown>;
		const outputRecord = output as Record<string, unknown>;
		for (const key of Object.keys(sourceRecord)) {
			// Skip prototype-polluting keys to guard against __proto__/constructor
			// injection via untrusted JSON config (fixes #2542).
			if (key === "__proto__" || key === "constructor" || key === "prototype") {
				continue;
			}
			const sourceValue = sourceRecord[key];
			const targetValue = outputRecord[key];

			if (isObject(sourceValue) && isObject(targetValue)) {
				outputRecord[key] = mergeDeep(targetValue, sourceValue);
			} else if (Array.isArray(sourceValue) && Array.isArray(targetValue)) {
				if (key === "allowedBaseUrls" || key === "internalBaseUrlAllowList") {
					outputRecord[key] = intersectAllowedBaseUrls(
						targetValue,
						sourceValue,
					) as unknown;
					continue;
				}
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

function intersectAllowedBaseUrls(
	targetValue: unknown[],
	sourceValue: unknown[],
): string[] {
	const targetEntries = targetValue.filter(
		(entry): entry is string => typeof entry === "string",
	);
	const sourceEntries = sourceValue.filter(
		(entry): entry is string => typeof entry === "string",
	);
	const merged = new Map<string, string>();
	const invalidEntries: string[] = [];
	for (const targetEntry of targetEntries) {
		const targetUrl = parsePolicyUrlForMerge(targetEntry);
		if (!targetUrl) {
			invalidEntries.push(targetEntry);
			continue;
		}
		for (const sourceEntry of sourceEntries) {
			const sourceUrl = parsePolicyUrlForMerge(sourceEntry);
			if (!sourceUrl) {
				invalidEntries.push(sourceEntry);
				continue;
			}
			if (urlMatchesStrictPrefix(sourceUrl, targetUrl)) {
				merged.set(sourceUrl.toString(), sourceEntry);
			} else if (urlMatchesStrictPrefix(targetUrl, sourceUrl)) {
				merged.set(targetUrl.toString(), targetEntry);
			}
		}
	}
	const intersection = [...merged.values()];
	const validEntries =
		intersection.length > 0
			? intersection
			: targetValue.filter(
					(entry): entry is string => typeof entry === "string",
				);
	const result = [...validEntries];
	for (const invalidEntry of invalidEntries) {
		if (!result.includes(invalidEntry)) {
			result.push(invalidEntry);
		}
	}
	return result;
}

function parsePolicyUrlForMerge(value: string): URL | null {
	try {
		return new URL(value);
	} catch {
		return null;
	}
}

export function mergeHeaders(
	base?: Record<string, string>,
	overrides?: Record<string, string>,
): Record<string, string> | undefined {
	if (!base && !overrides) {
		return undefined;
	}
	return { ...(base ?? {}), ...(overrides ?? {}) };
}

function isObject(item: unknown): item is Record<string, unknown> {
	return item !== null && typeof item === "object" && !Array.isArray(item);
}

export function formatValidationErrors(errors?: ErrorObject[] | null): string {
	if (!errors || errors.length === 0) {
		return "Invalid configuration";
	}
	return errors
		.map(
			(err) => `${err.instancePath || "/"} ${err.message ?? "invalid value"}`,
		)
		.join("; ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Config File Loading
// ─────────────────────────────────────────────────────────────────────────────

/** Cached file contents keyed by path */
export const fileSnapshots = new Map<
	string,
	{ mtimeMs: number; data: string }
>();

/** Cached merged config */
export let cachedConfig: CustomModelConfig | null = null;
let cachedConfigCheckedFactoryFallback = false;

export function clearCachedConfig(): void {
	cachedConfig = null;
	cachedConfigCheckedFactoryFallback = false;
	fileSnapshots.clear();
}

export function setCachedConfig(config: CustomModelConfig): void {
	cachedConfig = config;
	cachedConfigCheckedFactoryFallback = true;
}

/**
 * Config file paths in order of precedence (last wins)
 */
export function getConfigPathEntries(): ConfigPathEntry[] {
	const paths: ConfigPathEntry[] = [];

	// 1. Global config
	paths.push({
		path: join(PATHS.MAESTRO_HOME, "config.json"),
		scope: "global",
		trusted: true,
	});
	paths.push({
		path: join(PATHS.MAESTRO_HOME, "local.json"),
		scope: "global",
		trusted: true,
	});

	// 2. Project config (current directory)
	const projectTrusted = isProjectModelConfigTrusted();
	const projectConfig = join(process.cwd(), ".maestro", "config.json");
	if (existsSync(projectConfig)) {
		paths.push({
			path: projectConfig,
			scope: "project",
			trusted: projectTrusted,
		});
	}
	const projectLocal = join(process.cwd(), ".maestro", "local.json");
	if (existsSync(projectLocal)) {
		paths.push({
			path: projectLocal,
			scope: "project",
			trusted: projectTrusted,
		});
	}

	// 3. Legacy path for backward compatibility
	const legacyPath = join(PATHS.MAESTRO_HOME, "models.json");
	if (existsSync(legacyPath)) {
		paths.push({
			path: legacyPath,
			scope: "legacy",
			trusted: true,
		});
	}

	// 4. Environment variable override
	if (process.env.MAESTRO_MODELS_FILE) {
		const override = resolveEnvPath(process.env.MAESTRO_MODELS_FILE);
		if (override) paths.push({ path: override, scope: "env", trusted: true });
	}

	if (process.env.MAESTRO_CONFIG) {
		const override = resolveEnvPath(process.env.MAESTRO_CONFIG);
		if (override) paths.push({ path: override, scope: "env", trusted: true });
	}

	return paths;
}

export function getConfigPaths(): string[] {
	return getConfigPathEntries().map((entry) => entry.path);
}

export function configPath(): string {
	return (
		resolveEnvPath(process.env.MAESTRO_MODELS_FILE) ??
		join(PATHS.MAESTRO_HOME, "models.json")
	);
}

/**
 * Parse JSONC (JSON with comments) with helpful error messages
 */
export function parseJsoncWithErrors(text: string, filePath: string): unknown {
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
				const lastLine = beforeOffset[beforeOffset.length - 1];
				const column = (lastLine?.length ?? 0) + 1;
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

export function readJsonFile(filePath: string): string | null {
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
function loadConfigFileWithOptions(
	path: string,
	options?: { expandReferences?: boolean },
): CustomModelConfig | null {
	const raw = existsSync(path) ? readJsonFile(path) : null;
	if (!raw) {
		return null;
	}

	try {
		let processed = raw;
		if (options?.expandReferences !== false) {
			// Process file references first (before env vars, so file contents can have env vars)
			const configDir = dirname(path);
			processed = substituteFileRefs(processed, configDir);

			// Process environment variable substitution
			processed = substituteEnvVars(processed, logger);
		}

		// Parse JSONC (supports comments and trailing commas)
		const data = parseJsoncWithErrors(processed, path);

		if (!configValidator(data)) {
			throw new Error(formatValidationErrors(configValidator.errors));
		}

		const config = data as CustomModelConfig;
		return config;
	} catch (error) {
		throw new Error(
			`Failed to parse config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export function loadConfigFile(
	path: string,
	options?: { expandReferences?: boolean },
): CustomModelConfig | null {
	return loadConfigFileWithOptions(path, options);
}

export function loadUntrustedProjectConfigFile(
	path: string,
): CustomModelConfig | null {
	const raw = existsSync(path) ? readJsonFile(path) : null;
	if (!raw) {
		return null;
	}

	try {
		const data = parseJsoncWithErrors(raw, path);
		return sanitizeUntrustedProjectConfig(data, path);
	} catch (error) {
		logger.warn("Ignoring invalid untrusted project model config", {
			path,
			trustEnv: TRUST_PROJECT_MODEL_CONFIG_ENV,
			error: sanitizeWithStaticMask(
				error instanceof Error ? error.message : String(error),
			),
		});
		return { providers: [] };
	}
}

export function sanitizeUntrustedProjectConfig(
	config: unknown,
	path: string,
): CustomModelConfig {
	const providers: CustomProvider[] = [];
	if (!isRecord(config)) {
		logger.warn("Ignoring invalid untrusted project model config", {
			path,
			trustEnv: TRUST_PROJECT_MODEL_CONFIG_ENV,
		});
		return { providers };
	}

	const sanitized =
		"providers" in config ||
		"aliases" in config ||
		Object.keys(config).some((key) => key !== "$schema");

	if (sanitized) {
		logger.warn("Ignoring sensitive project model config fields", {
			path,
			trustEnv: TRUST_PROJECT_MODEL_CONFIG_ENV,
		});
	}

	return { providers };
}

/**
 * Apply provider-specific configurations
 */
export function applyProviderLoader(
	provider: CustomProvider,
	options?: { includeDisabled?: boolean },
): CustomProvider | null {
	const baseName = provider.id.split("-")[0] ?? provider.id;
	const loader = PROVIDER_LOADERS[provider.id] ?? PROVIDER_LOADERS[baseName];
	const enhanced: CustomProvider = { ...provider };
	let enabled = provider.enabled ?? true;

	if (loader) {
		const result = loader(provider.id);

		// Merge loader results with provider config
		if (result) {
			if (result.headers) {
				enhanced.headers = mergeHeaders(result.headers, enhanced.headers);
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
	}

	if (enabled === false && !options?.includeDisabled) {
		return null;
	}

	return enhanced;
}

/**
 * Load config with hierarchy (global -> project -> env)
 */
export function loadConfig(
	includeDisabled = false,
	ensureFactory?: (policy: CustomModelUrlPolicyConfig) => {
		config: CustomModelConfig;
		modelProviderMap: Map<string, string>;
	} | null,
	options?: {
		validateUrls?: boolean;
	},
): CustomModelConfig {
	const needsFactoryAwareConfig = Boolean(ensureFactory);
	const shouldValidateUrls = options?.validateUrls ?? true;
	if (
		cachedConfig &&
		!includeDisabled &&
		(!needsFactoryAwareConfig || cachedConfigCheckedFactoryFallback)
	) {
		return cachedConfig;
	}

	// Try loading from hierarchy
	const paths = getConfigPathEntries();
	let mergedConfig: CustomModelConfig = { providers: [] };

	for (const entry of paths) {
		const untrustedProject = entry.scope === "project" && !entry.trusted;
		const config = untrustedProject
			? loadUntrustedProjectConfigFile(entry.path)
			: loadConfigFile(entry.path);
		if (config) {
			mergedConfig = mergeDeep(mergedConfig, config);
		}
	}
	const hadConfiguredProviders = mergedConfig.providers.length > 0;

	// If no configs found, try Factory fallback
	if (mergedConfig.providers.length === 0 && ensureFactory) {
		const factoryFallback = ensureFactory(mergedConfig);
		if (factoryFallback) {
			const fallbackConfig: CustomModelConfig = {
				...factoryFallback.config,
				...(mergedConfig.allowedBaseUrls
					? { allowedBaseUrls: mergedConfig.allowedBaseUrls }
					: {}),
				...(mergedConfig.internalBaseUrlAllowList
					? {
							internalBaseUrlAllowList: mergedConfig.internalBaseUrlAllowList,
						}
					: {}),
			};
			if (shouldValidateUrls) {
				validateCustomModelConfigUrls(
					fallbackConfig,
					"merged model configuration",
				);
			}
			if (!includeDisabled) {
				cachedConfig = fallbackConfig;
				cachedConfigCheckedFactoryFallback = true;
			}
			return fallbackConfig;
		}
	}

	// Apply provider-specific loaders
	mergedConfig.providers = mergedConfig.providers
		.map((provider) => applyProviderLoader(provider, { includeDisabled }))
		.filter((provider): provider is CustomProvider => Boolean(provider));

	if (shouldValidateUrls) {
		validateCustomModelConfigUrls(mergedConfig, "merged model configuration");
	}

	if (!includeDisabled) {
		cachedConfig = mergedConfig;
		cachedConfigCheckedFactoryFallback =
			Boolean(ensureFactory) || hadConfiguredProviders;
	}
	return mergedConfig;
}

export function getMergedCustomModelUrlPolicyConfig(): CustomModelUrlPolicyConfig {
	// Avoid priming the shared config cache before registry loading has a chance
	// to apply Factory fallback providers. We only need the allow-lists here, so
	// skip merged URL validation to keep the last registered registry usable after
	// validation rejects an edited config on disk.
	const { allowedBaseUrls, internalBaseUrlAllowList } =
		cachedConfig ?? loadConfig(true, undefined, { validateUrls: false });
	return {
		...(allowedBaseUrls ? { allowedBaseUrls } : {}),
		...(internalBaseUrlAllowList ? { internalBaseUrlAllowList } : {}),
	};
}
