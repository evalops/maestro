import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { safeJsonParse } from "../utils/json.js";

// Portions of this module are derived from https://github.com/sst/opencode-anthropic-auth (MIT).

export type AnthropicLoginMode = "pro" | "console";

export interface AnthropicOAuthCredential {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	mode: AnthropicLoginMode;
}

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

const CLAUDE_LOGIN_HOST: Record<AnthropicLoginMode, string> = {
	pro: "claude.ai",
	console: "console.anthropic.com",
};

interface AnthropicTokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	error?: string;
}

interface ClaudeApiKeyResponse {
	raw_key?: string;
}

const DEFAULT_BASE_DIR = (() => {
	const agentDir = process.env.COMPOSER_AGENT_DIR;
	if (agentDir) {
		return resolve(agentDir, "..");
	}
	return join(homedir(), ".composer");
})();

const AUTH_FILE = resolve(
	process.env.ANTHROPIC_OAUTH_FILE ??
		join(DEFAULT_BASE_DIR, "anthropic-oauth.json"),
);

export const CLAUDE_CODE_BETA_HEADER =
	"oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14,advanced-tool-use-2025-11-20";

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

export async function getStoredAnthropicOAuthCredential(): Promise<AnthropicOAuthCredential | null> {
	try {
		const contents = readFileSync(AUTH_FILE, "utf8");
		const result = safeJsonParse<{
			accessToken?: unknown;
			refreshToken?: unknown;
			expiresAt?: unknown;
			mode?: unknown;
		}>(contents, "Anthropic auth credentials");

		if (!result.success) {
			return null;
		}

		const parsed = result.data;
		if (
			typeof parsed.accessToken === "string" &&
			typeof parsed.refreshToken === "string" &&
			typeof parsed.expiresAt === "number"
		) {
			return {
				accessToken: parsed.accessToken,
				refreshToken: parsed.refreshToken,
				expiresAt: parsed.expiresAt,
				mode: parsed.mode === "console" ? "console" : "pro",
			};
		}
		return null;
	} catch {
		return null;
	}
}

export async function saveAnthropicOAuthCredential(
	credential: AnthropicOAuthCredential,
): Promise<void> {
	ensureAuthDir();
	writeFileSync(AUTH_FILE, JSON.stringify(credential, null, 2), {
		encoding: "utf8",
		mode: 0o600,
	});
}

export async function deleteAnthropicOAuthCredential(): Promise<void> {
	try {
		await rm(AUTH_FILE);
	} catch {
		// ignore when file does not exist
	}
}

export async function getFreshAnthropicOAuthCredential(): Promise<AnthropicOAuthCredential | null> {
	const stored = await getStoredAnthropicOAuthCredential();
	if (!stored) {
		return null;
	}
	if (stored.expiresAt - Date.now() > 60_000) {
		return stored;
	}
	const refreshed = await refreshAnthropicOAuthToken(stored.refreshToken);
	if (!refreshed) {
		await deleteAnthropicOAuthCredential();
		return null;
	}
	const next: AnthropicOAuthCredential = {
		...stored,
		accessToken: refreshed.accessToken,
		refreshToken: refreshed.refreshToken ?? stored.refreshToken,
		expiresAt: refreshed.expiresAt,
	};
	await saveAnthropicOAuthCredential(next);
	return next;
}

export async function generateAnthropicLoginUrl(
	mode: AnthropicLoginMode = "pro",
) {
	const pkce = await generatePKCE();
	const base = new URL(
		`https://${CLAUDE_LOGIN_HOST[mode]}/oauth/authorize`,
		`https://${CLAUDE_LOGIN_HOST[mode]}`,
	);
	base.searchParams.set("code", "true");
	base.searchParams.set("client_id", CLIENT_ID);
	base.searchParams.set("response_type", "code");
	base.searchParams.set(
		"redirect_uri",
		"https://console.anthropic.com/oauth/code/callback",
	);
	base.searchParams.set(
		"scope",
		"org:create_api_key user:profile user:inference",
	);
	base.searchParams.set("code_challenge", pkce.challenge);
	base.searchParams.set("code_challenge_method", "S256");
	base.searchParams.set("state", pkce.verifier);
	return { url: base.toString(), verifier: pkce.verifier };
}

export async function exchangeAnthropicAuthorizationCode(
	code: string,
	verifier: string,
): Promise<{
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
} | null> {
	const [actualCode, state] = code.trim().split("#");
	if (!actualCode || !state) {
		return null;
	}
	const response = await fetch("https://console.anthropic.com/v1/oauth/token", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			code: actualCode,
			state,
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			redirect_uri: "https://console.anthropic.com/oauth/code/callback",
			code_verifier: verifier,
		}),
	});
	if (!response.ok) {
		return null;
	}
	const payload = (await response.json()) as AnthropicTokenResponse;
	if (!payload.access_token || !payload.refresh_token) {
		return null;
	}
	return {
		accessToken: payload.access_token,
		refreshToken: payload.refresh_token,
		expiresAt: Date.now() + (payload.expires_in ?? 0) * 1000,
	};
}

export async function refreshAnthropicOAuthToken(
	refreshToken: string,
): Promise<{
	accessToken: string;
	refreshToken?: string;
	expiresAt: number;
} | null> {
	const response = await fetch("https://console.anthropic.com/v1/oauth/token", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: CLIENT_ID,
		}),
	});
	if (!response.ok) {
		return null;
	}
	const payload = (await response.json()) as AnthropicTokenResponse;
	if (!payload.access_token) {
		return null;
	}
	return {
		accessToken: payload.access_token,
		refreshToken: payload.refresh_token,
		expiresAt: Date.now() + (payload.expires_in ?? 0) * 1000,
	};
}

export async function fetchClaudeApiKey(
	accessToken: string,
): Promise<string | null> {
	const response = await fetch(
		"https://api.anthropic.com/api/oauth/claude_cli/create_api_key",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				authorization: `Bearer ${accessToken}`,
			},
		},
	);
	if (!response.ok) {
		return null;
	}
	const payload = (await response.json()) as ClaudeApiKeyResponse;
	return typeof payload.raw_key === "string" ? payload.raw_key : null;
}
