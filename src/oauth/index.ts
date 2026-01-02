import type { AnthropicLoginMode } from "../providers/anthropic-auth.js";
import { createLogger } from "../utils/logger.js";
import {
	loginAnthropic,
	migrateAnthropicCredentials,
	refreshAnthropicToken,
} from "./anthropic.js";
import {
	loginGitHubCopilot,
	migrateGitHubCopilotCredentials,
	refreshGitHubCopilotToken,
} from "./github-copilot.js";
import {
	loginGoogleGeminiCli,
	refreshGoogleGeminiCliToken,
} from "./google-gemini-cli.js";
import {
	loginOpenAI,
	migrateOpenAICredentials,
	refreshOpenAIToken,
} from "./openai.js";
import {
	type OAuthCredentials,
	listOAuthProviders as listOAuthProvidersFromStorage,
	loadOAuthCredentials,
	removeOAuthCredentials,
	saveOAuthCredentials,
} from "./storage.js";

const logger = createLogger("oauth");

// Re-export for convenience
export { listOAuthProvidersFromStorage as listOAuthProviders };
export type { OAuthCredentials } from "./storage.js";

export type SupportedOAuthProvider =
	| "anthropic"
	| "openai"
	| "github-copilot"
	| "google-gemini-cli";

export interface OAuthProviderInfo {
	id: SupportedOAuthProvider;
	name: string;
	description: string;
	available: boolean;
}

/**
 * Get list of OAuth providers
 */
export function getOAuthProviders(): OAuthProviderInfo[] {
	return [
		{
			id: "anthropic",
			name: "Anthropic",
			description: "Claude Pro/Max subscription",
			available: true,
		},
		{
			id: "openai",
			name: "OpenAI",
			description: "ChatGPT Plus subscription",
			available: true,
		},
		{
			id: "google-gemini-cli",
			name: "Google Gemini CLI",
			description: "Cloud Code Assist OAuth",
			available: true,
		},
		{
			id: "github-copilot",
			name: "GitHub Copilot",
			description: "GitHub Copilot subscription",
			available: true,
		},
	];
}

/**
 * Check if a provider has OAuth credentials stored
 */
export function hasOAuthCredentials(provider: SupportedOAuthProvider): boolean {
	return loadOAuthCredentials(provider) !== null;
}

/**
 * Login with OAuth provider
 */
export async function login(
	provider: SupportedOAuthProvider,
	options: {
		mode?: AnthropicLoginMode;
		onAuthUrl: (url: string) => void;
		onPromptCode?: () => Promise<string>;
		onStatus?: (status: string) => void;
		onDeviceCode?: (code: string, verificationUri: string) => void;
	},
): Promise<void> {
	switch (provider) {
		case "anthropic":
			if (!options.onPromptCode) {
				throw new Error(
					"Anthropic login requires onPromptCode callback for auth code input",
				);
			}
			await loginAnthropic(
				options.mode ?? "pro",
				options.onAuthUrl,
				options.onPromptCode,
			);
			break;
		case "openai":
			await loginOpenAI(options.onAuthUrl, options.onStatus);
			break;
		case "google-gemini-cli":
			await loginGoogleGeminiCli(options.onAuthUrl, options.onStatus);
			break;
		case "github-copilot":
			if (!options.onDeviceCode) {
				throw new Error(
					"GitHub Copilot requires onDeviceCode callback for device flow",
				);
			}
			await loginGitHubCopilot(options.onDeviceCode, options.onStatus);
			break;
		default:
			throw new Error(`Unknown OAuth provider: ${provider}`);
	}
}

/**
 * Logout from OAuth provider
 */
export async function logout(provider: SupportedOAuthProvider): Promise<void> {
	removeOAuthCredentials(provider);
}

/**
 * Refresh OAuth token for provider
 */
export async function refreshToken(
	provider: SupportedOAuthProvider,
): Promise<string> {
	const credentials = loadOAuthCredentials(provider);
	if (!credentials) {
		throw new Error(`No OAuth credentials found for ${provider}`);
	}

	let newCredentials: OAuthCredentials;

	switch (provider) {
		case "anthropic":
			newCredentials = await refreshAnthropicToken(
				credentials.refresh,
				credentials.metadata,
			);
			break;
		case "openai":
			newCredentials = await refreshOpenAIToken(
				credentials.refresh,
				credentials.metadata,
			);
			break;
		case "google-gemini-cli":
			newCredentials = await refreshGoogleGeminiCliToken(
				credentials.refresh,
				credentials.metadata,
			);
			break;
		case "github-copilot":
			newCredentials = await refreshGitHubCopilotToken(
				credentials.refresh,
				credentials.metadata,
			);
			break;
		default:
			throw new Error(`Unknown OAuth provider: ${provider}`);
	}

	// Save new credentials
	saveOAuthCredentials(provider, newCredentials);

	return newCredentials.access;
}

/**
 * Get OAuth token for provider (auto-refreshes if expired)
 */
export async function getOAuthToken(
	provider: SupportedOAuthProvider,
): Promise<string | null> {
	const credentials = loadOAuthCredentials(provider);
	if (!credentials) {
		return null;
	}

	// Check if token is expired (with 1 min buffer)
	if (Date.now() >= credentials.expires - 60_000) {
		// Token expired or expiring soon - refresh it
		try {
			return await refreshToken(provider);
		} catch (error) {
			logger.error(
				"Failed to refresh OAuth token",
				error instanceof Error ? error : new Error(String(error)),
				{ provider },
			);
			// Remove invalid credentials
			removeOAuthCredentials(provider);
			return null;
		}
	}

	return credentials.access;
}

/**
 * Migrate old provider-specific OAuth credentials to new generic format
 */
export async function migrateOAuthCredentials(): Promise<void> {
	// Migrate Anthropic credentials
	const anthropicMigrated = await migrateAnthropicCredentials();
	if (anthropicMigrated) {
		logger.info("Migrated Anthropic OAuth credentials to new format");
	}

	// Migrate OpenAI credentials
	const openaiMigrated = await migrateOpenAICredentials();
	if (openaiMigrated) {
		logger.info("Migrated OpenAI OAuth credentials to new format");
	}

	// Migrate GitHub Copilot credentials from environment
	const copilotMigrated = await migrateGitHubCopilotCredentials();
	if (copilotMigrated) {
		logger.info("Migrated GitHub Copilot credentials from environment");
	}
}
