/**
 * Authentication Resolver - Unified Credential Resolution
 *
 * This module provides a unified authentication resolver that handles
 * multiple credential sources and authentication modes for all supported
 * AI providers. It abstracts the complexity of OAuth, API keys, and
 * environment variables into a single interface.
 *
 * ## Authentication Modes
 *
 * | Mode     | Description                                    |
 * |----------|------------------------------------------------|
 * | auto     | Try OAuth first, fallback to API keys (default)|
 * | api-key  | Only use API keys, skip OAuth                  |
 * | claude   | Only use Anthropic OAuth, fail if unavailable  |
 *
 * ## Credential Resolution Order
 *
 * 1. **Explicit API key**: Passed directly via options
 * 2. **OAuth tokens**: Provider-specific OAuth flows (if mode allows)
 * 3. **Environment variables**: Standard env var lookup
 * 4. **Custom providers**: From models registry configuration
 *
 * ## Credential Sources
 *
 * | Source              | Description                              |
 * |---------------------|------------------------------------------|
 * | explicit            | Passed directly to resolver              |
 * | env                 | From environment variable                |
 * | custom_literal      | Hardcoded in custom provider config      |
 * | custom_env          | Env var from custom provider config      |
 * | anthropic_oauth_env | Anthropic OAuth token from env           |
 * | anthropic_oauth_file| Anthropic OAuth from stored credentials  |
 * | openai_oauth_file   | OpenAI OAuth from stored credentials     |
 * | google_oauth_file   | Google OAuth from stored credentials     |
 *
 * ## Example
 *
 * ```typescript
 * const resolver = createAuthResolver({ mode: 'auto' });
 * const credential = await resolver('anthropic');
 *
 * if (credential) {
 *   console.log(`Using ${credential.type} from ${credential.source}`);
 *   // Use credential.token for API requests
 * }
 * ```
 *
 * @module providers/auth
 */

import { getOAuthToken } from "../oauth/index.js";
import { loadOAuthCredentials } from "../oauth/storage.js";
import { getFreshAnthropicOAuthCredential } from "./anthropic-auth.js";
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
	| "openai_oauth_file"
	| "google_oauth_file";

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

function isGoogleGeminiCliProvider(provider: string): boolean {
	const normalized = provider.toLowerCase();
	return (
		normalized === "google-gemini-cli" || normalized === "google-antigravity"
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

		if (isGoogleGeminiCliProvider(provider) && options.mode !== "api-key") {
			const oauthProvider =
				normalizedProvider === "google-antigravity"
					? "google-antigravity"
					: "google-gemini-cli";
			const oauthToken = await getOAuthToken(oauthProvider);
			if (oauthToken) {
				const credentials = loadOAuthCredentials(oauthProvider);
				const projectId =
					typeof credentials?.metadata?.projectId === "string"
						? credentials.metadata.projectId
						: undefined;
				if (projectId) {
					return {
						provider,
						token: JSON.stringify({ token: oauthToken, projectId }),
						type: "api-key",
						source: "google_oauth_file",
						metadata: credentials?.metadata,
					};
				}
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

			// Try new OAuth system first (oauth.json)
			const newOAuthToken = await getOAuthToken("anthropic");
			if (newOAuthToken) {
				const credentials = loadOAuthCredentials("anthropic");
				return {
					provider,
					token: newOAuthToken,
					type: "anthropic-oauth",
					source: "anthropic_oauth_file",
					metadata: credentials?.metadata,
				};
			}

			// Fall back to legacy OAuth system (anthropic-oauth.json)
			const stored = await getFreshAnthropicOAuthCredential();
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
