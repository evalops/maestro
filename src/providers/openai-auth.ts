/**
 * OpenAI OAuth Authentication
 *
 * This module implements OAuth 2.0 with PKCE for authenticating with
 * OpenAI's API. It uses a local callback server to receive the
 * authorization code after user authentication.
 *
 * ## Authentication Flow
 *
 * ```
 * ┌─────────────────────────────────────────────────────────────┐
 * │                     OpenAI OAuth Flow                       │
 * ├─────────────────────────────────────────────────────────────┤
 * │  1. Generate PKCE challenge and state token                 │
 * │  2. Generate login URL → User opens in browser              │
 * │  3. Start local callback server on port 1455                │
 * │  4. User authenticates at auth.openai.com                   │
 * │  5. Receive authorization code via callback                 │
 * │  6. Exchange code for access/refresh/ID tokens              │
 * │  7. Exchange ID token for API key                           │
 * │  8. Store credentials in ~/.maestro/openai-oauth.json      │
 * └─────────────────────────────────────────────────────────────┘
 * ```
 *
 * ## Token Types
 *
 * | Token        | Purpose                                    |
 * |--------------|---------------------------------------------|
 * | accessToken  | OAuth access token                          |
 * | refreshToken | For refreshing expired tokens               |
 * | idToken      | OpenID Connect token for API key exchange   |
 * | apiKey       | Actual API key for OpenAI requests          |
 *
 * ## Token Storage
 *
 * Credentials are stored at:
 * - Default: `~/.maestro/openai-oauth.json`
 * - Custom: `$OPENAI_OAUTH_FILE`
 *
 * File is created with mode 0o600 (owner read/write only).
 *
 * ## Key Functions
 *
 * - `generateOpenAILoginUrl()`: Create OAuth URL for browser
 * - `exchangeOpenAIAuthorizationCode()`: Exchange code for tokens
 * - `getFreshOpenAIOAuthCredential()`: Get valid token (auto-refresh)
 * - `exchangeIdTokenForApiKey()`: Convert ID token to API key
 *
 * @module providers/openai-auth
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "../config/constants.js";
import { safeJsonParse } from "../utils/json.js";

export type OpenAILoginMode = "openai-oauth";

export interface OpenAIOAuthCredential {
	accessToken: string;
	refreshToken: string;
	idToken: string;
	expiresAt: number;
	apiKey?: string;
	mode: OpenAILoginMode;
}

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ORIGINATOR = "codex_cli_rs"; // Using the same originator as Codex CLI for compatibility
const ISSUER = "https://auth.openai.com";
const DEFAULT_PORT = 1455;
const LOCAL_CALLBACK_ORIGIN = `http://127.0.0.1:${DEFAULT_PORT}`;

interface OpenAITokenResponse {
	access_token?: string;
	refresh_token?: string;
	id_token?: string;
	expires_in?: number;
	error?: string;
}

interface OpenAIExchangeResponse {
	access_token: string; // This is the API key
}

const DEFAULT_BASE_DIR = resolve(getAgentDir(), "..");

const AUTH_FILE = resolve(
	process.env.OPENAI_OAUTH_FILE ?? join(DEFAULT_BASE_DIR, "openai-oauth.json"),
);

interface PKCEPair {
	verifier: string;
	challenge: string;
}

function toBase64Url(buffer: Buffer): string {
	return buffer
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

async function generatePKCE(): Promise<PKCEPair> {
	const verifier = toBase64Url(randomBytes(32));
	const challenge = toBase64Url(createHash("sha256").update(verifier).digest());
	return { verifier, challenge };
}

function ensureAuthDir(): void {
	mkdirSync(dirname(AUTH_FILE), { recursive: true });
}

export async function getStoredOpenAIOAuthCredential(): Promise<OpenAIOAuthCredential | null> {
	try {
		const contents = readFileSync(AUTH_FILE, "utf8");
		const result = safeJsonParse<{
			accessToken?: unknown;
			refreshToken?: unknown;
			idToken?: unknown;
			expiresAt?: unknown;
			apiKey?: unknown;
			mode?: unknown;
		}>(contents, "OpenAI auth credentials");

		if (!result.success) {
			return null;
		}

		const parsed = result.data;
		if (
			typeof parsed.accessToken === "string" &&
			typeof parsed.refreshToken === "string" &&
			typeof parsed.idToken === "string" &&
			typeof parsed.expiresAt === "number"
		) {
			return {
				accessToken: parsed.accessToken,
				refreshToken: parsed.refreshToken,
				idToken: parsed.idToken,
				expiresAt: parsed.expiresAt,
				apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : undefined,
				mode: "openai-oauth",
			};
		}
		return null;
	} catch {
		return null;
	}
}

export async function saveOpenAIOAuthCredential(
	credential: OpenAIOAuthCredential,
): Promise<void> {
	ensureAuthDir();
	writeFileSync(AUTH_FILE, JSON.stringify(credential, null, 2), {
		encoding: "utf8",
		mode: 0o600,
	});
}

export async function deleteOpenAIOAuthCredential(): Promise<void> {
	try {
		await rm(AUTH_FILE);
	} catch {
		// ignore when file does not exist
	}
}

export async function getFreshOpenAIOAuthCredential(): Promise<OpenAIOAuthCredential | null> {
	const stored = await getStoredOpenAIOAuthCredential();
	if (!stored) {
		return null;
	}
	if (stored.expiresAt - Date.now() > 60_000) {
		return stored;
	}
	const refreshed = await refreshOpenAIOAuthToken(stored.refreshToken);
	if (!refreshed) {
		await deleteOpenAIOAuthCredential();
		return null;
	}
	const next: OpenAIOAuthCredential = {
		...stored,
		accessToken: refreshed.accessToken,
		refreshToken: refreshed.refreshToken ?? stored.refreshToken,
		idToken: refreshed.idToken ?? stored.idToken,
		expiresAt: refreshed.expiresAt,
		// Note: We might want to re-exchange for API key if ID token changed,
		// but typically the API key (access token from exchange) is long-lived or we just reuse the old one if not provided?
		// Actually, if we refreshed the token, we might need a new API key if the old one expired,
		// but the API key from token exchange acts like a session key.
		// For now, keep the old API key unless we implement re-exchange logic here.
	};

	// If we got a new ID token, let's try to get a new API key
	if (refreshed.idToken && refreshed.idToken !== stored.idToken) {
		const newApiKey = await exchangeIdTokenForApiKey(refreshed.idToken);
		if (newApiKey) {
			next.apiKey = newApiKey;
		}
	}

	await saveOpenAIOAuthCredential(next);
	return next;
}

export async function generateOpenAILoginUrl() {
	const pkce = await generatePKCE();
	const state = toBase64Url(randomBytes(32));

	const base = new URL(`${ISSUER}/oauth/authorize`);
	base.searchParams.set("response_type", "code");
	base.searchParams.set("client_id", CLIENT_ID);
	base.searchParams.set(
		"redirect_uri",
		`${LOCAL_CALLBACK_ORIGIN}/auth/callback`,
	);
	base.searchParams.set("scope", "openid profile email offline_access");
	base.searchParams.set("code_challenge", pkce.challenge);
	base.searchParams.set("code_challenge_method", "S256");
	base.searchParams.set("id_token_add_organizations", "true");
	base.searchParams.set("codex_cli_simplified_flow", "true");
	base.searchParams.set("state", state);
	base.searchParams.set("originator", ORIGINATOR);

	return { url: base.toString(), verifier: pkce.verifier, state };
}

export async function exchangeOpenAIAuthorizationCode(
	code: string,
	verifier: string,
): Promise<{
	accessToken: string;
	refreshToken: string;
	idToken: string;
	expiresAt: number;
} | null> {
	const response = await fetch(`${ISSUER}/oauth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: `${LOCAL_CALLBACK_ORIGIN}/auth/callback`,
			client_id: CLIENT_ID,
			code_verifier: verifier,
		}).toString(),
	});
	if (!response.ok) {
		return null;
	}
	const payload = (await response.json()) as OpenAITokenResponse;
	if (!payload.access_token || !payload.refresh_token || !payload.id_token) {
		return null;
	}
	return {
		accessToken: payload.access_token,
		refreshToken: payload.refresh_token,
		idToken: payload.id_token,
		expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
	};
}

export async function refreshOpenAIOAuthToken(refreshToken: string): Promise<{
	accessToken: string;
	refreshToken?: string;
	idToken?: string;
	expiresAt: number;
} | null> {
	const response = await fetch(`${ISSUER}/oauth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: CLIENT_ID,
			scope: "openid profile email offline_access",
		}).toString(),
	});
	if (!response.ok) {
		return null;
	}
	const payload = (await response.json()) as OpenAITokenResponse;
	if (!payload.access_token) {
		return null;
	}
	return {
		accessToken: payload.access_token,
		refreshToken: payload.refresh_token,
		idToken: payload.id_token,
		expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
	};
}

export async function exchangeIdTokenForApiKey(
	idToken: string,
): Promise<string | null> {
	const response = await fetch(`${ISSUER}/oauth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
			client_id: CLIENT_ID,
			requested_token: "openai-api-key",
			subject_token: idToken,
			subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
		}).toString(),
	});
	if (!response.ok) {
		return null;
	}
	const payload = (await response.json()) as OpenAIExchangeResponse;
	return payload.access_token || null;
}
