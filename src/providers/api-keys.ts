/**
 * API Key Lookup - Environment Variable and Custom Provider Resolution
 *
 * This module handles API key discovery from environment variables and
 * custom provider configurations. It provides a consistent interface
 * for looking up credentials across all supported AI providers.
 *
 * ## Known Providers and Environment Variables
 *
 * | Provider   | Environment Variables                     |
 * |------------|-------------------------------------------|
 * | google     | GEMINI_API_KEY                            |
 * | openai     | OPENAI_API_KEY                            |
 * | anthropic  | ANTHROPIC_OAUTH_TOKEN, ANTHROPIC_API_KEY  |
 * | bedrock    | AWS_ACCESS_KEY_ID, AWS_PROFILE, etc.      |
 * | writer     | WRITER_API_KEY                            |
 * | xai        | XAI_API_KEY                               |
 * | groq       | GROQ_API_KEY                              |
 * | cerebras   | CEREBRAS_API_KEY                          |
 * | openrouter | OPENROUTER_API_KEY                        |
 * | zai        | ZAI_API_KEY                               |
 *
 * ## Key Sources
 *
 * | Source        | Description                               |
 * |---------------|-------------------------------------------|
 * | explicit      | Passed directly to lookup function        |
 * | env           | Found in environment variable             |
 * | custom_literal| Hardcoded in custom provider config       |
 * | custom_env    | Custom env var from provider config       |
 * | missing       | No key found                              |
 *
 * ## Custom Providers
 *
 * Custom providers can be defined in the models registry with either:
 * - `apiKey`: A literal API key value
 * - `apiKeyEnv`: An environment variable name to read from
 *
 * ## Example
 *
 * ```typescript
 * const result = lookupApiKey('anthropic');
 *
 * if (result.key) {
 *   console.log(`Found key from ${result.source}`);
 *   if (result.envVar) {
 *     console.log(`Environment variable: ${result.envVar}`);
 *   }
 * } else {
 *   console.log(`Checked: ${result.checkedEnvVars.join(', ')}`);
 * }
 * ```
 *
 * @module providers/api-keys
 */

import { getCustomProviderMetadata } from "../models/registry.js";
import { hasAwsCredentials } from "./aws-auth.js";

export const envApiKeyMap = {
	google: ["GEMINI_API_KEY"],
	openai: ["OPENAI_API_KEY"],
	anthropic: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
	bedrock: [
		"AWS_ACCESS_KEY_ID",
		"AWS_PROFILE",
		"AWS_SSO_SESSION_NAME",
		"AWS_WEB_IDENTITY_TOKEN_FILE",
		"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	],
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

	// Special handling for Bedrock - uses AWS credential chain, not API key
	if (provider === "bedrock") {
		checkedEnvVars.push(...envApiKeyMap.bedrock);
		if (hasAwsCredentials()) {
			return {
				provider,
				key: "aws-credentials", // Placeholder - SDK handles actual credentials
				source: "env",
				checkedEnvVars,
			};
		}
		return {
			provider,
			source: "missing",
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
