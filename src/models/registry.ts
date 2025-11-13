import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Api, Model, Provider } from "../agent/types.js";
import { getModel, getModels, getProviders } from "./builtin.js";
import { z } from "zod";

const COST_DEFAULT = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
} as const;

const headersSchema = z.record(z.string()).optional();

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
	baseUrl: z.string().url().optional(),
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
	baseUrl: modelSchema.shape.baseUrl,
	apiKeyEnv: z.string().min(1).optional(),
	apiKey: z.string().min(1).optional(),
	models: z.array(modelSchema).min(1),
});

const configSchema = z.object({
	providers: z.array(providerSchema).default([]),
});

export type CustomModelConfig = z.infer<typeof configSchema>;
export type CustomProvider = z.infer<typeof providerSchema>;
export type CustomModel = z.infer<typeof modelSchema>;

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

const configPath = (): string =>
	process.env.COMPOSER_MODELS_FILE
		? resolve(process.env.COMPOSER_MODELS_FILE)
		: join(homedir(), ".composer", "models.json");

let cachedConfig: CustomModelConfig | null = null;
let cachedProviders: RegisteredModel[] | null = null;
const customProviderMetadata = new Map<string, ProviderMetadata>();

function loadConfig(): CustomModelConfig {
	if (cachedConfig) {
		return cachedConfig;
	}
	const path = configPath();
	if (!existsSync(path)) {
		cachedConfig = { providers: [] };
		return cachedConfig;
	}
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = configSchema.parse(JSON.parse(raw));
		cachedConfig = parsed;
		return parsed;
	} catch (error) {
		throw new Error(
			`Failed to parse custom model config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function toModel(provider: CustomProvider, model: CustomModel): Model<Api> {
	const api = model.api ?? provider.api;
	const baseUrl = model.baseUrl ?? provider.baseUrl;
	if (!api || !baseUrl) {
		throw new Error(
			`Model ${provider.id}/${model.id} is missing api or baseUrl. Specify them either on the model or provider entry in ${configPath()}.`,
		);
	}
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
	loadConfig();
	getRegisteredModels();
}

export function resolveModel(
	provider: Provider,
	modelId: string,
): Model<Api> | null {
	// Custom first
	const config = loadConfig();
	const customProvider = config.providers.find((p) => p.id === provider);
	if (customProvider) {
		const customModel = customProvider.models.find((m) => m.id === modelId);
		if (customModel) {
			return toModel(customProvider, customModel);
		}
	}
	try {
		return getModel(provider as any, modelId as any) as Model<Api>;
	} catch {
		return null;
	}
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
