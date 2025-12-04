import {
	type AnthropicOAuthCredential,
	getFreshAnthropicOAuthCredential,
} from "./anthropic-auth.js";
import { lookupApiKey } from "./api-keys.js";
import { getFreshOpenAIOAuthCredential } from "./openai-auth.js";

export type AuthMode = "auto" | "api-key" | "claude";

export type AuthCredentialType = "api-key" | "anthropic-oauth";

export type AuthCredentialSource =
	| "explicit"
	| "env"
	| "custom_literal"
	| "custom_env"
	| "anthropic_oauth_env"
	| "anthropic_oauth_file"
	| "openai_oauth_file";

export interface AuthCredential {
	provider: string;
	token: string;
	type: AuthCredentialType;
	source: AuthCredentialSource;
	envVar?: string;
	metadata?: Record<string, unknown>;
}

export interface AuthResolverOptions {
	mode: AuthMode;
	explicitApiKey?: string;
}

type AuthResolver = (provider: string) => Promise<AuthCredential | undefined>;

const ANTHROPIC_OAUTH_ENV_VARS = [
	"CLAUDE_CODE_TOKEN",
	"ANTHROPIC_OAUTH_TOKEN",
	"ANTHROPIC_ACCESS_TOKEN",
];

function isOpenAIProvider(provider: string): boolean {
	const normalized = provider.toLowerCase();
	return (
		normalized === "openai" ||
		normalized.startsWith("openai/") ||
		normalized.includes("openai-")
	);
}

export function createAuthResolver(options: AuthResolverOptions): AuthResolver {
	const explicitKey = options.explicitApiKey?.trim();
	return async (provider: string): Promise<AuthCredential | undefined> => {
		const normalizedProvider = provider.toLowerCase();

		if (explicitKey) {
			return {
				provider,
				token: explicitKey,
				type: "api-key",
				source: "explicit",
			};
		}

		// Handle OpenAI Auth
		if (isOpenAIProvider(provider) && options.mode !== "api-key") {
			// OpenAI OAuth
			const oauthCred = await getFreshOpenAIOAuthCredential();
			if (oauthCred?.apiKey) {
				return {
					provider,
					token: oauthCred.apiKey,
					type: "api-key",
					source: "openai_oauth_file",
					metadata: { mode: oauthCred.mode },
				};
			}
		}

		const preferAnthropicOAuth =
			normalizedProvider === "anthropic" && options.mode !== "api-key";

		if (preferAnthropicOAuth) {
			const envTokenEntry = ANTHROPIC_OAUTH_ENV_VARS.map((envVar) => ({
				envVar,
				token: process.env[envVar]?.trim(),
			})).find((entry) => entry.token);
			if (envTokenEntry?.token) {
				return {
					provider,
					token: envTokenEntry.token,
					type: "anthropic-oauth",
					source: "anthropic_oauth_env",
					envVar: envTokenEntry.envVar,
				};
			}
			const stored: AnthropicOAuthCredential | null =
				await getFreshAnthropicOAuthCredential();
			if (stored) {
				return {
					provider,
					token: stored.accessToken,
					type: "anthropic-oauth",
					source: "anthropic_oauth_file",
					metadata: { mode: stored.mode },
				};
			}
			if (options.mode === "claude") {
				return undefined;
			}
		}

		const lookup = lookupApiKey(provider, explicitKey);
		if (lookup.key) {
			if (lookup.source === "missing") {
				return undefined;
			}
			return {
				provider,
				token: lookup.key,
				type: "api-key",
				source: lookup.source,
				envVar: lookup.envVar,
			};
		}
		return undefined;
	};
}
