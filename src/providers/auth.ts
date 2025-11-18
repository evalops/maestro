import { lookupApiKey } from "./api-keys.js";

export type AuthMode = "auto" | "api-key" | "chatgpt";

export type AuthCredentialType = "api-key" | "chatgpt";

export type AuthCredentialSource =
	| "explicit"
	| "env"
	| "custom_literal"
	| "custom_env"
	| "codex_env"
	| "codex_flag";

export interface AuthCredential {
	provider: string;
	token: string;
	type: AuthCredentialType;
	source: AuthCredentialSource;
	envVar?: string;
}

export interface AuthResolverOptions {
	mode: AuthMode;
	explicitApiKey?: string;
	codexApiKey?: string;
	codexSource?: "env" | "flag";
}

type AuthResolver = (provider: string) => AuthCredential | undefined;

const CODEX_DEFAULT_ENV = "CODEX_API_KEY";

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
	return (provider: string): AuthCredential | undefined => {
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
