import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { z } from "zod";
import type { Api, Model, Provider } from "../agent/types.js";
import { getModel, getModels, getProviders } from "./builtin.js";
import {
	parse as parseJsonc,
	type ParseError as JsoncParseError,
	printParseErrorCode,
} from "jsonc-parser";

const COST_DEFAULT = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
} as const;

const headersSchema = z.record(z.string()).optional();

const baseUrlSchema = z
	.string()
	.url("Base URL must be a valid URL")
	.refine(
		(url) => {
			// Warn about common mistakes but don't fail (we auto-normalize)
			return true;
		},
		{ message: "Base URL will be auto-normalized if incomplete" }
	);

const modelSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	api: z
		.enum([
			"openai-completions",
			"openai-responses",
			"anthropic-messages",
			"google-generative-ai",
		])
		.optional(),
	baseUrl: baseUrlSchema.optional(),
	reasoning: z.boolean().optional(),
	input: z.array(z.enum(["text", "image"])).optional(),
	cost: z
		.object({
			input: z.number().nonnegative(),
			output: z.number().nonnegative(),
			cacheRead: z.number().nonnegative(),
			cacheWrite: z.number().nonnegative(),
		})
		.optional(),
	contextWindow: z.number().positive(),
	maxTokens: z.number().positive(),
	headers: headersSchema,
});

const providerSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	api: modelSchema.shape.api.optional(),
	baseUrl: baseUrlSchema.optional(),
	apiKeyEnv: z.string().min(1).optional(),
	apiKey: z.string().min(1).optional(),
	models: z.array(modelSchema).min(1),
});

const configSchema = z.object({
	$schema: z.string().optional(),
	providers: z.array(providerSchema).default([]),
	aliases: z.record(z.string()).optional().describe("Model aliases for convenience (e.g., 'fast': 'anthropic/claude-haiku')"),
});

export type CustomModelConfig = z.infer<typeof configSchema>;
export type CustomProvider = z.infer<typeof providerSchema>;
export type CustomModel = z.infer<typeof modelSchema>;

/**
 * Deep merge two objects (simple implementation for configs)
 */
function mergeDeep<T>(target: T, source: Partial<T>): T {
	const output = { ...target };
	
	if (isObject(target) && isObject(source)) {
		Object.keys(source).forEach(key => {
			const sourceValue = (source as any)[key];
			const targetValue = (output as any)[key];
			
			if (isObject(sourceValue) && isObject(targetValue)) {
				(output as any)[key] = mergeDeep(targetValue, sourceValue);
			} else if (Array.isArray(sourceValue) && Array.isArray(targetValue)) {
				// For arrays, concatenate and dedupe by id if objects have id property
				const merged = [...targetValue];
				for (const item of sourceValue) {
					if (item && typeof item === 'object' && 'id' in item) {
						const existingIndex = merged.findIndex((m: any) => m?.id === item.id);
						if (existingIndex >= 0) {
							// Merge existing item
							merged[existingIndex] = mergeDeep(merged[existingIndex], item);
						} else {
							merged.push(item);
						}
					} else {
						merged.push(item);
					}
				}
				(output as any)[key] = merged;
			} else {
				(output as any)[key] = sourceValue;
			}
		});
	}
	
	return output;
}

function isObject(item: unknown): item is Record<string, unknown> {
	return item !== null && typeof item === 'object' && !Array.isArray(item);
}

export interface RegisteredModel extends Model<Api> {
	providerName: string;
	source: "builtin" | "custom";
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
	
	// 2. Project config (current directory)
	const projectConfig = join(process.cwd(), ".composer", "config.json");
	if (existsSync(projectConfig)) {
		paths.push(projectConfig);
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
			process.env.AWS_BEARER_TOKEN_BEDROCK
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
	provider: CustomProvider
): CustomProvider {
	const loader = 
		PROVIDER_LOADERS[provider.id] ??
		PROVIDER_LOADERS[provider.id.split("-")[0]]; // Try base name (e.g., "bedrock" from "aws-bedrock")
	
	if (!loader) {
		return provider;
	}
	
	const result = loader(provider.id);
	if (!result) {
		return provider;
	}
	
	// Merge loader results with provider config
	const enhanced = { ...provider };
	
	if (result.headers) {
		enhanced.models = enhanced.models.map(model => ({
			...model,
			headers: { ...result.headers, ...model.headers },
		}));
	}
	
	if (result.baseUrl && !provider.baseUrl) {
		enhanced.baseUrl = result.baseUrl;
	}
	
	return enhanced;
}

/**
 * Substitute environment variables in config text
 * Replaces {env:VAR_NAME} with the value of process.env.VAR_NAME
 */
function substituteEnvVars(text: string): string {
	return text.replace(/\{env:([^}]+)\}/g, (match, varName) => {
		const value = process.env[varName];
		if (value === undefined) {
			console.warn(`[Config Warning] Environment variable ${varName} is not set, using empty string`);
			return "";
		}
		return value;
	});
}

/**
 * Substitute file references in config text
 * Replaces {file:path} with the contents of the file
 * Supports relative paths (resolved from config directory) and absolute paths
 * Supports ~/path for home directory
 */
function substituteFileRefs(text: string, configDir: string): string {
	const lines = text.split("\n");
	let result = "";
	
	for (const line of lines) {
		// Skip commented lines (don't process file refs in comments)
		const trimmed = line.trim();
		if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
			result += line + "\n";
			continue;
		}
		
		let processedLine = line;
		const matches = [...line.matchAll(/\{file:([^}]+)\}/g)];
		
		for (const match of matches) {
			let filePath = match[1];
			
			// Handle home directory (~/)
			if (filePath.startsWith("~/")) {
				filePath = join(homedir(), filePath.slice(2));
			}
			// Handle relative paths
			else if (!filePath.startsWith("/")) {
				filePath = join(configDir, filePath);
			}
			
			try {
				const fileContent = readFileSync(filePath, "utf-8").trim();
				// Escape for JSON string (handle newlines, quotes, etc.)
				const escaped = JSON.stringify(fileContent).slice(1, -1);
				processedLine = processedLine.replace(match[0], escaped);
			} catch (error) {
				const errMsg = error instanceof Error ? error.message : String(error);
				throw new Error(
					`Failed to read file reference "${match[0]}" in config: ${filePath}\n${errMsg}`
				);
			}
		}
		
		result += processedLine + "\n";
	}
	
	return result;
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
			`Failed to parse JSONC config at ${filePath}:\n${errorDetails}`
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
		processed = substituteEnvVars(processed);
		
		// Parse JSONC (supports comments and trailing commas)
		const data = parseJsoncWithErrors(processed, path);
		
		// Validate with Zod schema
		const parsed = configSchema.parse(data);
		
		return parsed;
	} catch (error) {
		throw new Error(
			`Failed to parse config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Load config with hierarchy (global -> project -> env)
 */
function loadConfig(): CustomModelConfig {
	if (cachedConfig) {
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
			cachedConfig = factoryFallback.config;
			return cachedConfig;
		}
	}
	
	// Apply provider-specific loaders
	mergedConfig.providers = mergedConfig.providers.map(applyProviderLoader);
	
	cachedConfig = mergedConfig;
	return mergedConfig;
}

function validateBaseUrl(baseUrl: string, providerId: string, api?: Api): void {
	// Validate common provider URL patterns
	if (providerId === "anthropic" || api === "anthropic-messages") {
		if (baseUrl.includes("api.anthropic.com")) {
			if (!baseUrl.includes("/v1/messages") && !baseUrl.includes("/v1/complete")) {
				console.warn(
					`[Config Warning] Anthropic base URL should end with /v1/messages. ` +
					`Got: ${baseUrl}. Auto-normalizing to include /v1/messages.`
				);
			}
		}
	}
	
	if (providerId.includes("bedrock") || providerId.includes("aws")) {
		if (baseUrl.includes("bedrock.") && !baseUrl.includes("bedrock-runtime.")) {
			console.warn(
				`[Config Warning] AWS Bedrock URL should use 'bedrock-runtime', not 'bedrock'. ` +
				`Got: ${baseUrl}. Auto-normalizing to bedrock-runtime.`
			);
		}
	}
	
	if (providerId.includes("vertex") || providerId.includes("google")) {
		if (baseUrl.includes("aiplatform.googleapis.com") && !baseUrl.includes("/v1/")) {
			console.warn(
				`[Config Warning] Google Vertex AI URLs should include full path with /v1/. ` +
				`Got: ${baseUrl}. You may need to specify the full endpoint including project and location.`
			);
		}
	}
}

function normalizeBaseUrl(baseUrl: string, providerId: string, api?: Api): string {
	let normalized = baseUrl;
	
	// Validate first (logs warnings)
	validateBaseUrl(baseUrl, providerId, api);
	
	// Anthropic direct API
	if ((providerId === "anthropic" || api === "anthropic-messages") && 
	    normalized.includes("api.anthropic.com") && 
	    !normalized.includes("/v1/messages")) {
		normalized = normalized.replace(/\/$/, "") + "/v1/messages";
	}
	
	// AWS Bedrock
	if (providerId.includes("bedrock") || providerId.includes("aws")) {
		if (normalized.includes("bedrock") && 
		    normalized.includes("amazonaws.com") &&
		    !normalized.includes("bedrock-runtime")) {
			normalized = normalized.replace("bedrock.", "bedrock-runtime.");
		}
	}
	
	// Google Vertex AI
	if (providerId.includes("vertex") || providerId.includes("google")) {
		if (normalized.includes("aiplatform.googleapis.com") && 
		    !normalized.includes("/v1/")) {
			normalized = normalized.replace(/\/$/, "");
		}
	}
	
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
		});
		for (const model of provider.models) {
			const resolved = toModel(provider, model);
			registry.push({
				...resolved,
				providerName: provider.name,
				source: "custom",
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
	return match ?? null;
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
		const parsed = JSON.parse(raw) as FactoryConfigFile;
		if (!parsed.custom_models?.length) {
			return null;
		}
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
				api
			);
			
			const uniqueKey = `${entry.provider ?? "factory"}|${normalizedBaseUrl}|${entry.api_key ?? ""}`;
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
					apiKey: entry.api_key,
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
		const enhancedProviders = providers.map(applyProviderLoader);

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
		const parsed = JSON.parse(sanitized);
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
			result.errors.push(`Failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
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
		apiKeySource?: string;
		modelCount: number;
		models: Array<{
			id: string;
			name: string;
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
	const config = loadConfig();
	
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
		
		inspection.providers.push({
			id: provider.id,
			name: provider.name,
			baseUrl: provider.baseUrl || "(auto-generated)",
			apiKeySource,
			modelCount: provider.models.length,
			models: provider.models.map(m => ({
				id: m.id,
				name: m.name,
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
				} catch {}
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
			maskedValue = value.length > 8
				? `${value.slice(0, 4)}${"•".repeat(8)}`
				: "••••••••";
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
export function resolveAlias(alias: string): { provider: string; modelId: string } | null {
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
		console.warn(`[Config Warning] Invalid alias target "${target}". Expected format: "provider/modelId"`);
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
