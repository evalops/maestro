/**
 * GitHub Copilot OAuth integration for Composer.
 *
 * Uses GitHub's OAuth Device Flow for authentication, which is suitable
 * for CLI applications where users authenticate in a browser.
 *
 * Flow:
 * 1. Request device code from GitHub
 * 2. Display user code and URL to user
 * 3. Poll for access token while user authorizes
 * 4. Exchange for Copilot API token
 */

import { createLogger } from "../utils/logger.js";
import {
	type OAuthCredentials,
	loadOAuthCredentials,
	saveOAuthCredentials,
} from "./storage.js";

const logger = createLogger("oauth:github-copilot");

// GitHub CLI OAuth App client ID (public, used by gh CLI)
const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98";

// Copilot-specific client ID (used by Copilot CLI)
const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";

// GitHub OAuth endpoints
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";

// Required scope for Copilot access
const COPILOT_SCOPE = "copilot";

interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	expires_in: number;
	interval: number;
}

interface AccessTokenResponse {
	access_token?: string;
	token_type?: string;
	scope?: string;
	error?: string;
	error_description?: string;
}

interface CopilotTokenResponse {
	token: string;
	expires_at: number;
}

export interface GitHubCopilotCredential {
	accessToken: string;
	copilotToken?: string;
	copilotTokenExpires?: number;
	scope: string;
}

/**
 * Convert GitHub Copilot credentials to generic OAuth credentials.
 */
function toGenericCredentials(cred: GitHubCopilotCredential): OAuthCredentials {
	return {
		type: "oauth",
		access: cred.copilotToken ?? cred.accessToken,
		refresh: cred.accessToken, // Use GitHub token as refresh mechanism
		expires: cred.copilotTokenExpires ?? Date.now() + 8 * 60 * 60 * 1000, // 8 hours default
		metadata: {
			scope: cred.scope,
			githubToken: cred.accessToken,
		},
	};
}

/**
 * Request a device code from GitHub.
 */
async function requestDeviceCode(): Promise<DeviceCodeResponse> {
	const response = await fetch(DEVICE_CODE_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			client_id: COPILOT_CLIENT_ID,
			scope: COPILOT_SCOPE,
		}).toString(),
	});

	if (!response.ok) {
		throw new Error(`Failed to request device code: ${response.status}`);
	}

	const data = (await response.json()) as DeviceCodeResponse;

	if (!data.device_code || !data.user_code) {
		throw new Error("Invalid device code response");
	}

	return data;
}

/**
 * Poll for access token after user authorization.
 */
async function pollForAccessToken(
	deviceCode: string,
	interval: number,
	expiresIn: number,
): Promise<string> {
	const startTime = Date.now();
	const expiresAt = startTime + expiresIn * 1000;
	let currentInterval = interval * 1000;

	while (Date.now() < expiresAt) {
		await new Promise((resolve) => setTimeout(resolve, currentInterval));

		const response = await fetch(ACCESS_TOKEN_URL, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				client_id: COPILOT_CLIENT_ID,
				device_code: deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			}).toString(),
		});

		if (!response.ok) {
			throw new Error(`Token request failed: ${response.status}`);
		}

		const data = (await response.json()) as AccessTokenResponse;

		if (data.access_token) {
			return data.access_token;
		}

		if (data.error === "authorization_pending") {
			// User hasn't authorized yet, keep polling
			continue;
		}

		if (data.error === "slow_down") {
			// Increase polling interval
			currentInterval += 5000;
			continue;
		}

		if (data.error === "expired_token") {
			throw new Error("Device code expired. Please try again.");
		}

		if (data.error === "access_denied") {
			throw new Error("Authorization denied by user.");
		}

		if (data.error) {
			throw new Error(
				`OAuth error: ${data.error} - ${data.error_description ?? ""}`,
			);
		}
	}

	throw new Error("Device code expired. Please try again.");
}

/**
 * Exchange GitHub token for Copilot API token.
 */
async function getCopilotToken(
	githubToken: string,
): Promise<CopilotTokenResponse | null> {
	try {
		const response = await fetch(COPILOT_TOKEN_URL, {
			method: "GET",
			headers: {
				Authorization: `token ${githubToken}`,
				Accept: "application/json",
				"Editor-Version": "Composer/1.0.0",
				"Editor-Plugin-Version": "copilot/1.0.0",
			},
		});

		if (!response.ok) {
			logger.warn("Failed to get Copilot token", {
				status: response.status,
			});
			return null;
		}

		const data = (await response.json()) as CopilotTokenResponse;
		return data;
	} catch (error) {
		logger.warn("Error getting Copilot token", {
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/**
 * Start the OAuth login flow for GitHub Copilot.
 *
 * Uses the device flow: displays a code for the user to enter
 * at github.com/login/device, then polls for the access token.
 */
export async function loginGitHubCopilot(
	onDeviceCode: (code: string, verificationUri: string) => void,
	onStatus?: (status: string) => void,
): Promise<void> {
	onStatus?.("Requesting device code...");

	// Request device code
	const deviceCode = await requestDeviceCode();

	// Display code to user
	onDeviceCode(deviceCode.user_code, deviceCode.verification_uri);

	onStatus?.("Waiting for authorization...");

	// Poll for access token
	const accessToken = await pollForAccessToken(
		deviceCode.device_code,
		deviceCode.interval,
		deviceCode.expires_in,
	);

	onStatus?.("Getting Copilot token...");

	// Try to get Copilot-specific token
	const copilotToken = await getCopilotToken(accessToken);

	const credential: GitHubCopilotCredential = {
		accessToken,
		copilotToken: copilotToken?.token,
		copilotTokenExpires: copilotToken?.expires_at
			? copilotToken.expires_at * 1000
			: undefined,
		scope: COPILOT_SCOPE,
	};

	// Save credentials
	const genericCreds = toGenericCredentials(credential);
	saveOAuthCredentials("github-copilot", genericCreds);

	logger.info("GitHub Copilot OAuth login successful");
}

/**
 * Refresh GitHub Copilot token.
 *
 * The GitHub token itself doesn't expire, but the Copilot token does.
 * We use the stored GitHub token to get a fresh Copilot token.
 */
export async function refreshGitHubCopilotToken(
	_refreshToken: string,
	metadata?: Record<string, unknown>,
): Promise<OAuthCredentials> {
	const githubToken = (metadata?.githubToken as string) ?? _refreshToken;

	// Get fresh Copilot token
	const copilotToken = await getCopilotToken(githubToken);

	if (!copilotToken) {
		throw new Error(
			"Failed to refresh Copilot token. Please login again with /login github-copilot",
		);
	}

	return {
		type: "oauth",
		access: copilotToken.token,
		refresh: githubToken,
		expires: copilotToken.expires_at * 1000,
		metadata: {
			...(metadata ?? {}),
			scope: COPILOT_SCOPE,
			githubToken,
		},
	};
}

/**
 * Check if user has valid GitHub Copilot credentials.
 */
export function hasGitHubCopilotCredentials(): boolean {
	return loadOAuthCredentials("github-copilot") !== null;
}

/**
 * Migrate old GitHub Copilot credentials (if any).
 * Currently no migration needed as this is a new feature.
 */
export async function migrateGitHubCopilotCredentials(): Promise<boolean> {
	// Check for COPILOT_GITHUB_TOKEN or GH_TOKEN environment variables
	const envToken = process.env.COPILOT_GITHUB_TOKEN ?? process.env.GH_TOKEN;

	if (envToken && !loadOAuthCredentials("github-copilot")) {
		// Try to convert env token to stored credential
		const copilotToken = await getCopilotToken(envToken);

		if (copilotToken) {
			const credential: GitHubCopilotCredential = {
				accessToken: envToken,
				copilotToken: copilotToken.token,
				copilotTokenExpires: copilotToken.expires_at * 1000,
				scope: COPILOT_SCOPE,
			};

			saveOAuthCredentials("github-copilot", toGenericCredentials(credential));
			logger.info(
				"Migrated GitHub token from environment to OAuth credentials",
			);
			return true;
		}
	}

	return false;
}
