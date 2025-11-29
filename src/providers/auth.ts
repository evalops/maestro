import {
	type AnthropicOAuthCredential,
	getFreshAnthropicOAuthCredential,
} from "./anthropic-auth.js";
import { lookupApiKey } from "./api-keys.js";

export type AuthMode = "auto" | "api-key" | "chatgpt" | "claude";

export type AuthCredentialType = "api-key" | "chatgpt" | "anthropic-oauth";

export type AuthCredentialSource =
	| "explicit"
	| "env"
	| "custom_literal"
	| "custom_env"
	| "codex_env"
	| "codex_flag"
	| "anthropic_oauth_env"
	| "anthropic_oauth_file";

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
	codexApiKey?: string;
	codexSource?: "env" | "flag";
}

type AuthResolver = (provider: string) => Promise<AuthCredential | undefined>;

const CODEX_DEFAULT_ENV = "CODEX_API_KEY";
const ANTHROPIC_OAUTH_ENV_VARS = [
	"CLAUDE_CODE_TOKEN",
	"ANTHROPIC_OAUTH_TOKEN",
	"ANTHROPIC_ACCESS_TOKEN",
];

function shouldUseCodexToken(
	provider: string,
	mode: AuthMode,
	token?: string,
): boolean {
	if (!token) {
		return false;
	}
	if (mode === "api-key") {
		return false;
	}
	const normalized = provider.toLowerCase();
	const supported =
		normalized === "openai" ||
		normalized === "chatgpt" ||
		normalized.startsWith("openai/") ||
		normalized.includes("openai-");
	return supported;
}

export function createAuthResolver(options: AuthResolverOptions): AuthResolver {
	const explicitKey = options.explicitApiKey?.trim();
	const codexToken = options.codexApiKey?.trim();
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

		if (shouldUseCodexToken(provider, options.mode, codexToken)) {
			if (!codexToken) {
				return undefined;
			}
			return {
				provider,
				token: codexToken,
				type: "chatgpt",
				source: options.codexSource === "flag" ? "codex_flag" : "codex_env",
				envVar: options.codexSource === "env" ? CODEX_DEFAULT_ENV : undefined,
			};
		}

		const preferAnthropicOAuth =
			normalizedProvider === "anthropic" &&
			options.mode !== "chatgpt" &&
			options.mode !== "api-key";

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

		if (options.mode === "chatgpt") {
			return undefined;
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

export { CODEX_DEFAULT_ENV };
