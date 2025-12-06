import { getCustomProviderMetadata } from "../models/registry.js";

export const envApiKeyMap = {
	google: ["GEMINI_API_KEY"],
	openai: ["OPENAI_API_KEY"],
	anthropic: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
	writer: ["WRITER_API_KEY"],
	xai: ["XAI_API_KEY"],
	groq: ["GROQ_API_KEY"],
	cerebras: ["CEREBRAS_API_KEY"],
	openrouter: ["OPENROUTER_API_KEY"],
	zai: ["ZAI_API_KEY"],
} as const satisfies Record<string, readonly string[]>;

export type KnownProvider = keyof typeof envApiKeyMap;

export function isKnownProvider(value: string): value is KnownProvider {
	return value in envApiKeyMap;
}

export type ApiKeySource =
	| "explicit"
	| "env"
	| "custom_literal"
	| "custom_env"
	| "missing";

export interface ApiKeyLookupResult {
	provider: string;
	key?: string;
	source: ApiKeySource;
	envVar?: string;
	checkedEnvVars: string[];
	customProviderName?: string;
}

export function lookupApiKey(
	provider: string,
	explicitKey?: string,
): ApiKeyLookupResult {
	const checkedEnvVars: string[] = [];

	if (explicitKey) {
		return {
			provider,
			key: explicitKey,
			source: "explicit",
			checkedEnvVars,
		};
	}

	if (isKnownProvider(provider)) {
		for (const envVar of envApiKeyMap[provider]) {
			checkedEnvVars.push(envVar);
			const envValue = process.env[envVar];
			if (envValue) {
				return {
					provider,
					key: envValue,
					source: "env",
					envVar,
					checkedEnvVars,
				};
			}
		}
	}

	const customMeta = getCustomProviderMetadata(provider);
	if (customMeta?.apiKey) {
		return {
			provider,
			key: customMeta.apiKey,
			source: "custom_literal",
			checkedEnvVars,
			customProviderName: customMeta.name,
		};
	}
	if (customMeta?.apiKeyEnv) {
		checkedEnvVars.push(customMeta.apiKeyEnv);
		const customEnvValue = process.env[customMeta.apiKeyEnv];
		if (customEnvValue) {
			return {
				provider,
				key: customEnvValue,
				source: "custom_env",
				envVar: customMeta.apiKeyEnv,
				checkedEnvVars,
				customProviderName: customMeta.name,
			};
		}
		return {
			provider,
			source: "missing",
			envVar: customMeta.apiKeyEnv,
			checkedEnvVars,
			customProviderName: customMeta.name,
		};
	}

	return {
		provider,
		source: "missing",
		checkedEnvVars,
	};
}

export function getEnvVarsForProvider(provider: string): string[] {
	if (isKnownProvider(provider)) {
		return [...envApiKeyMap[provider]];
	}
	const customMeta = getCustomProviderMetadata(provider);
	return customMeta?.apiKeyEnv ? [customMeta.apiKeyEnv] : [];
}
