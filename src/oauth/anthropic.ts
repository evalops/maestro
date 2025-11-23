import {
	type AnthropicLoginMode,
	type AnthropicOAuthCredential,
	exchangeAnthropicAuthorizationCode,
	generateAnthropicLoginUrl,
	refreshAnthropicOAuthToken,
} from "../providers/anthropic-auth.js";
import { createLogger } from "../utils/logger.js";
import { type OAuthCredentials, saveOAuthCredentials } from "./storage.js";

const logger = createLogger("oauth:anthropic");

/**
 * Login to Anthropic via OAuth
 */
export async function loginAnthropic(
	mode: AnthropicLoginMode,
	onAuthUrl: (url: string) => void,
	onPromptCode: () => Promise<string>,
): Promise<void> {
	// Generate OAuth URL
	const { url, verifier } = await generateAnthropicLoginUrl(mode);

	// Show URL to user
	onAuthUrl(url);

	// Get authorization code from user
	const code = await onPromptCode();

	if (!code) {
		throw new Error("Authorization code is required");
	}

	// Exchange code for tokens
	const tokens = await exchangeAnthropicAuthorizationCode(code, verifier);

	if (!tokens) {
		throw new Error("Failed to exchange authorization code");
	}

	// Convert to generic OAuth credentials
	const credentials: OAuthCredentials = {
		type: "oauth",
		access: tokens.accessToken,
		refresh: tokens.refreshToken,
		expires: tokens.expiresAt,
		metadata: { mode },
	};

	// Save to generic storage
	saveOAuthCredentials("anthropic", credentials);
}

/**
 * Refresh Anthropic OAuth token
 */
export async function refreshAnthropicToken(
	refreshToken: string,
	metadata?: Record<string, unknown>,
): Promise<OAuthCredentials> {
	const refreshed = await refreshAnthropicOAuthToken(refreshToken);

	if (!refreshed) {
		throw new Error("Failed to refresh Anthropic OAuth token");
	}

	return {
		type: "oauth",
		access: refreshed.accessToken,
		refresh: refreshed.refreshToken ?? refreshToken,
		expires: refreshed.expiresAt,
		metadata,
	};
}

/**
 * Migrate old Anthropic OAuth credentials to new generic format
 * This reads from the old ~/.composer/anthropic-oauth.json file
 * and migrates to the new ~/.composer/oauth.json format
 */
export async function migrateAnthropicCredentials(): Promise<boolean> {
	try {
		const {
			getStoredAnthropicOAuthCredential,
			deleteAnthropicOAuthCredential,
		} = await import("../providers/anthropic-auth.js");

		const oldCreds = await getStoredAnthropicOAuthCredential();

		if (!oldCreds) {
			return false; // No credentials to migrate
		}

		// Convert to new format
		const credentials: OAuthCredentials = {
			type: "oauth",
			access: oldCreds.accessToken,
			refresh: oldCreds.refreshToken,
			expires: oldCreds.expiresAt,
			metadata: { mode: oldCreds.mode },
		};

		// Save to new storage
		saveOAuthCredentials("anthropic", credentials);

		// Delete old file
		await deleteAnthropicOAuthCredential();

		return true;
	} catch (error) {
		logger.error(
			"Failed to migrate Anthropic OAuth credentials",
			error instanceof Error ? error : new Error(String(error)),
		);
		return false;
	}
}
