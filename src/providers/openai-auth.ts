import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { safeJsonParse } from "../utils/json.js";

export type OpenAILoginMode = "chatgpt";

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

const DEFAULT_BASE_DIR = (() => {
	const agentDir = process.env.COMPOSER_AGENT_DIR;
	if (agentDir) {
		return resolve(agentDir, "..");
	}
	return join(homedir(), ".composer");
})();

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
				mode: "chatgpt",
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
		`http://localhost:${DEFAULT_PORT}/auth/callback`,
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
			redirect_uri: `http://localhost:${DEFAULT_PORT}/auth/callback`,
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
