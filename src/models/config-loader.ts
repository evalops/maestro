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
import { compileTypeboxSchema } from "../utils/typebox-ajv.js";

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
			Type.Literal("anthropic-messages"),
			Type.Literal("google-generative-ai"),
			Type.Literal("google-gemini-cli"),
			Type.Literal("bedrock-converse"),
			Type.Literal("vertex-ai"),
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

export function clearCachedConfig(): void {
	cachedConfig = null;
}

export function setCachedConfig(config: CustomModelConfig): void {
	cachedConfig = config;
}

/**
 * Config file paths in order of precedence (last wins)
 */
export function getConfigPaths(): string[] {
	const paths: string[] = [];

	// 1. Global config
	paths.push(join(PATHS.MAESTRO_HOME, "config.json"));
	paths.push(join(PATHS.MAESTRO_HOME, "local.json"));

	// 2. Project config (current directory)
	const projectConfig = join(process.cwd(), ".maestro", "config.json");
	if (existsSync(projectConfig)) {
		paths.push(projectConfig);
	}
	const projectLocal = join(process.cwd(), ".maestro", "local.json");
	if (existsSync(projectLocal)) {
		paths.push(projectLocal);
	}

	// 3. Legacy path for backward compatibility
	const legacyPath = join(PATHS.MAESTRO_HOME, "models.json");
	if (existsSync(legacyPath)) {
		paths.push(legacyPath);
	}

	// 4. Environment variable override
	if (process.env.MAESTRO_MODELS_FILE) {
		const override = resolveEnvPath(process.env.MAESTRO_MODELS_FILE);
		if (override) paths.push(override);
	}

	if (process.env.MAESTRO_CONFIG) {
		const override = resolveEnvPath(process.env.MAESTRO_CONFIG);
		if (override) paths.push(override);
	}

	return paths;
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
export function loadConfigFile(path: string): CustomModelConfig | null {
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
 * Apply provider-specific configurations
 */
export function applyProviderLoader(
	provider: CustomProvider,
	options?: { includeDisabled?: boolean },
): CustomProvider | null {
	const baseName = provider.id.split("-")[0] ?? provider.id;
	const loader = PROVIDER_LOADERS[provider.id] ?? PROVIDER_LOADERS[baseName];

	if (!loader) {
		return provider;
	}

	const result = loader(provider.id);

	const enhanced: CustomProvider = { ...provider };
	let enabled = provider.enabled ?? true;

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
	ensureFactory?: () => {
		config: CustomModelConfig;
		modelProviderMap: Map<string, string>;
	} | null,
): CustomModelConfig {
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
	if (mergedConfig.providers.length === 0 && ensureFactory) {
		const factoryFallback = ensureFactory();
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
