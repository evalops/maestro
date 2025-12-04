/**
 * OpenAI OAuth integration for Composer.
 *
 * This module provides OAuth login flow for OpenAI/ChatGPT accounts,
 * allowing users to authenticate with their ChatGPT Plus subscription.
 */

import { timingSafeEqual } from "node:crypto";
import {
	type IncomingMessage,
	type ServerResponse,
	createServer,
} from "node:http";
import {
	type OpenAIOAuthCredential,
	exchangeIdTokenForApiKey,
	exchangeOpenAIAuthorizationCode,
	generateOpenAILoginUrl,
	getStoredOpenAIOAuthCredential,
	refreshOpenAIOAuthToken,
} from "../providers/openai-auth.js";
import { createLogger } from "../utils/logger.js";
import {
	type OAuthCredentials,
	loadOAuthCredentials,
	saveOAuthCredentials,
} from "./storage.js";

const logger = createLogger("oauth:openai");

const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";

/**
 * Convert OpenAI provider credentials to generic OAuth credentials.
 */
function toGenericCredentials(cred: OpenAIOAuthCredential): OAuthCredentials {
	return {
		type: "oauth",
		access: cred.apiKey ?? cred.accessToken,
		refresh: cred.refreshToken,
		expires: cred.expiresAt,
		metadata: {
			mode: cred.mode,
			idToken: cred.idToken,
			// Store original access token if we have API key
			originalAccessToken: cred.apiKey ? cred.accessToken : undefined,
		},
	};
}

/**
 * Start the OAuth login flow for OpenAI.
 *
 * This opens a local HTTP server to receive the OAuth callback,
 * then opens the browser to the OpenAI authorization page.
 */
export async function loginOpenAI(
	onAuthUrl: (url: string) => void,
	onStatus?: (status: string) => void,
): Promise<void> {
	// Generate login URL with PKCE
	const loginInfo = await generateOpenAILoginUrl();
	const { url, verifier: codeVerifier, state } = loginInfo;

	// Start local callback server
	const credentials = await new Promise<OpenAIOAuthCredential>(
		(resolve, reject) => {
			const server = createServer(
				async (req: IncomingMessage, res: ServerResponse) => {
					try {
						const reqUrl = new URL(
							req.url ?? "",
							`http://localhost:${CALLBACK_PORT}`,
						);

						if (reqUrl.pathname !== CALLBACK_PATH) {
							res.writeHead(404);
							res.end("Not found");
							return;
						}

						const code = reqUrl.searchParams.get("code");
						const returnedState = reqUrl.searchParams.get("state");
						const error = reqUrl.searchParams.get("error");
						const errorDescription =
							reqUrl.searchParams.get("error_description");

						if (error) {
							res.writeHead(400, { "Content-Type": "text/html" });
							res.end(`
								<html>
									<body style="font-family: sans-serif; padding: 40px;">
										<h1>Authentication Failed</h1>
										<p>Error: ${error}</p>
										<p>${errorDescription ?? ""}</p>
										<p>You can close this window.</p>
									</body>
								</html>
							`);
							server.close();
							reject(new Error(`OAuth error: ${error} - ${errorDescription}`));
							return;
						}

						if (!code || !returnedState) {
							res.writeHead(400, { "Content-Type": "text/html" });
							res.end(`
								<html>
									<body style="font-family: sans-serif; padding: 40px;">
										<h1>Invalid Callback</h1>
										<p>Missing authorization code or state.</p>
										<p>You can close this window.</p>
									</body>
								</html>
							`);
							server.close();
							reject(new Error("Missing code or state in callback"));
							return;
						}

						// Verify state to prevent CSRF
						const stateBuffer = Buffer.from(state);
						const returnedBuffer = Buffer.from(returnedState);
						if (
							stateBuffer.length !== returnedBuffer.length ||
							!timingSafeEqual(stateBuffer, returnedBuffer)
						) {
							res.writeHead(400, { "Content-Type": "text/html" });
							res.end(`
								<html>
									<body style="font-family: sans-serif; padding: 40px;">
										<h1>Security Error</h1>
										<p>State mismatch - possible CSRF attack.</p>
										<p>You can close this window.</p>
									</body>
								</html>
							`);
							server.close();
							reject(new Error("State mismatch in OAuth callback"));
							return;
						}

						onStatus?.("Exchanging authorization code...");

						// Exchange code for tokens
						const tokens = await exchangeOpenAIAuthorizationCode(
							code,
							codeVerifier,
						);

						if (!tokens) {
							throw new Error("Failed to exchange authorization code");
						}

						onStatus?.("Getting API key...");

						// Exchange ID token for API key
						let apiKey: string | undefined;
						try {
							const key = await exchangeIdTokenForApiKey(tokens.idToken);
							apiKey = key ?? undefined;
						} catch (error) {
							logger.warn("Failed to exchange ID token for API key", {
								error: error instanceof Error ? error.message : String(error),
							});
							// Continue without API key - will use access token directly
						}

						const credential: OpenAIOAuthCredential = {
							accessToken: tokens.accessToken,
							refreshToken: tokens.refreshToken,
							idToken: tokens.idToken,
							expiresAt: tokens.expiresAt,
							apiKey,
							mode: "openai-oauth",
						};

						res.writeHead(200, { "Content-Type": "text/html" });
						res.end(`
							<html>
								<body style="font-family: sans-serif; padding: 40px;">
									<h1>Success!</h1>
									<p>You are now logged in to OpenAI.</p>
									<p>You can close this window and return to Composer.</p>
									<script>window.close();</script>
								</body>
							</html>
						`);

						server.close();
						resolve(credential);
					} catch (error) {
						logger.error(
							"OAuth callback error",
							error instanceof Error ? error : new Error(String(error)),
						);
						res.writeHead(500, { "Content-Type": "text/html" });
						res.end(`
							<html>
								<body style="font-family: sans-serif; padding: 40px;">
									<h1>Error</h1>
									<p>An error occurred during authentication.</p>
									<p>${error instanceof Error ? error.message : String(error)}</p>
									<p>You can close this window.</p>
								</body>
							</html>
						`);
						server.close();
						reject(error);
					}
				},
			);

			server.listen(CALLBACK_PORT, "127.0.0.1", () => {
				logger.info("OAuth callback server started", { port: CALLBACK_PORT });
				// Tell the user to open the URL
				onAuthUrl(url);
			});

			server.on("error", (error) => {
				logger.error(
					"OAuth callback server error",
					error instanceof Error ? error : new Error(String(error)),
				);
				reject(error);
			});

			// Timeout after 5 minutes
			const timeout = setTimeout(
				() => {
					server.close();
					reject(new Error("OAuth login timed out"));
				},
				5 * 60 * 1000,
			);

			server.on("close", () => {
				clearTimeout(timeout);
			});
		},
	);

	// Save credentials
	const genericCreds = toGenericCredentials(credentials);
	saveOAuthCredentials("openai", genericCreds);

	logger.info("OpenAI OAuth login successful");
}

/**
 * Refresh an expired OpenAI OAuth token.
 */
export async function refreshOpenAIToken(
	refreshToken: string,
	metadata?: Record<string, unknown>,
): Promise<OAuthCredentials> {
	const tokens = await refreshOpenAIOAuthToken(refreshToken);
	if (!tokens) {
		throw new Error("Failed to refresh OpenAI OAuth token");
	}

	// Try to get new API key from refreshed ID token
	let apiKey: string | undefined;
	if (tokens.idToken) {
		try {
			const key = await exchangeIdTokenForApiKey(tokens.idToken);
			apiKey = key ?? undefined;
		} catch (error) {
			logger.warn("Failed to refresh API key from ID token", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return {
		type: "oauth",
		access: apiKey ?? tokens.accessToken,
		refresh: tokens.refreshToken ?? refreshToken,
		expires: tokens.expiresAt,
		metadata: {
			...(metadata ?? {}),
			mode: "openai-oauth",
			idToken: tokens.idToken,
			originalAccessToken: apiKey ? tokens.accessToken : undefined,
		},
	};
}

/**
 * Migrate old OpenAI OAuth credentials to new format.
 */
export async function migrateOpenAICredentials(): Promise<boolean> {
	// Check if already migrated
	const existing = loadOAuthCredentials("openai");
	if (existing) {
		return false; // Already have new format
	}

	// Try to load from old format
	try {
		const oldCreds = await getStoredOpenAIOAuthCredential();
		if (oldCreds) {
			const newCreds = toGenericCredentials(oldCreds);
			saveOAuthCredentials("openai", newCreds);
			logger.info("Migrated OpenAI OAuth credentials to new format");
			return true;
		}
	} catch (error) {
		logger.debug("No old OpenAI OAuth credentials to migrate", {
			error: error instanceof Error ? error.message : String(error),
		});
	}

	return false;
}
