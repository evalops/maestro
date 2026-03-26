/**
 * Authentication Setup - Credential resolution and validation.
 *
 * Extracts auth-related initialization from main.ts Phase 4:
 * auth mode determination, Codex flag validation, credential resolution,
 * and missing-auth error message building.
 *
 * @module bootstrap/auth-setup
 */

import chalk from "chalk";
import { getCustomProviderMetadata } from "../models/registry.js";
import { getEnvVarsForProvider } from "../providers/api-keys.js";
import {
	type AuthCredential,
	type AuthMode,
	createAuthResolver,
} from "../providers/auth.js";

/** A plain + colored error line for terminal display. */
export interface AuthLine {
	plain: string;
	colored: string;
}

export interface AuthSetupResult {
	/** Resolve a credential for a provider, throwing or exiting on failure. */
	requireCredential: (
		providerName: string,
		fatal: boolean,
	) => Promise<AuthCredential>;
	/** Build user-friendly error lines when credentials are missing. */
	buildMissingAuthLines: (providerName: string) => AuthLine[];
}

/**
 * Validate that no unsupported Codex/ChatGPT flags are used, and warn
 * about CODEX_API_KEY if present. Throws with an error message on invalid flags.
 */
export function validateCodexFlags(args: string[], command?: string): void {
	if (process.env.CODEX_API_KEY) {
		console.warn(
			chalk.yellow(
				"CODEX_API_KEY detected but Codex subscriptions are not supported. The value will be ignored.",
			),
		);
	}

	if (command !== "help" && command !== "config") {
		const codexFlagsUsed = args.some((arg, index) => {
			if (arg === "--codex-api-key" || arg.startsWith("--codex-api-key=")) {
				return true;
			}
			if (arg === "--auth" && args[index + 1] === "chatgpt") return true;
			if (arg.startsWith("--auth=chatgpt")) return true;
			return false;
		});
		if (codexFlagsUsed) {
			throw new Error(
				"Codex/ChatGPT auth mode is no longer supported. Use a standard OpenAI API key instead.",
			);
		}
	}
}

/**
 * Create the auth resolver and helper functions used throughout startup.
 */
export function createAuthSetup(params: {
	authMode: AuthMode;
	explicitApiKey?: string;
}): AuthSetupResult {
	const { authMode, explicitApiKey } = params;

	const authResolver = createAuthResolver({
		mode: authMode,
		explicitApiKey,
	});

	const buildMissingAuthLines = (providerName: string): AuthLine[] => {
		const lines: AuthLine[] = [];
		const push = (plain: string, colored?: string) => {
			lines.push({ plain, colored: colored ?? plain });
		};
		push(
			`Error: No credentials found for provider "${providerName}"`,
			chalk.red(`Error: No credentials found for provider "${providerName}"`),
		);
		if (authMode !== "api-key") {
			const loginHint =
				providerName === "anthropic"
					? 'Run "maestro anthropic login" (claude) or use /login to authenticate before retrying.'
					: providerName === "openai"
						? 'Run "maestro openai login" or use /login to authenticate before retrying.'
						: 'Run "/login" to authenticate before retrying.';
			push(
				`${loginHint} Or provide an API key for the selected provider.`,
				chalk.dim(
					`${loginHint} Or provide an API key for the selected provider.`,
				),
			);
		}
		const envVars = getEnvVarsForProvider(providerName);
		if (envVars.length) {
			push(
				`Set ${envVars.join(" or ")} or provide --api-key for ${providerName}.`,
				chalk.dim(
					`Set ${envVars.join(" or ")} or provide --api-key for ${providerName}.`,
				),
			);
		} else {
			const customMeta = getCustomProviderMetadata(providerName);
			if (customMeta?.apiKeyEnv) {
				push(
					`Set ${customMeta.apiKeyEnv} environment variable or provide --api-key for ${providerName}.`,
					chalk.dim(
						`Set ${customMeta.apiKeyEnv} environment variable or provide --api-key for ${providerName}.`,
					),
				);
			}
		}
		return lines;
	};

	const requireCredential = async (
		providerName: string,
		fatal: boolean,
	): Promise<AuthCredential> => {
		const credential = await authResolver(providerName);
		if (credential) {
			return credential;
		}
		const lines = buildMissingAuthLines(providerName);
		if (fatal) {
			for (const line of lines) {
				console.error(line.colored);
			}
			process.exit(1);
		}
		const plain = lines.map((line) => line.plain).join("\n");
		throw new Error(plain);
	};

	return { requireCredential, buildMissingAuthLines };
}
