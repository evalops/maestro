/**
 * OpenAI Codex OAuth integration.
 *
 * This is intentionally separate from the OpenAI Platform OAuth flow. Codex
 * uses the ChatGPT access token directly against the ChatGPT Codex backend,
 * while the regular OpenAI provider exchanges the login for a Platform API key.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
	type IncomingMessage,
	type Server,
	type ServerResponse,
	createServer,
} from "node:http";
import { createLogger } from "../utils/logger.js";
import { type OAuthCredentials, saveOAuthCredentials } from "./storage.js";

const logger = createLogger("oauth:openai-codex");

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${ISSUER}/oauth/authorize`;
const TOKEN_URL = `${ISSUER}/oauth/token`;
const CALLBACK_PORT = 1455;
const CALLBACK_HOST = "127.0.0.1";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/auth/callback`;
const CALLBACK_ORIGIN = `http://${CALLBACK_HOST}:${CALLBACK_PORT}`;
const SCOPE = "openid profile email offline_access";
const ORIGINATOR = "codex_cli_rs";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

interface TokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	error?: string;
	error_description?: string;
}

interface CodexJwtPayload {
	[JWT_CLAIM_PATH]?: {
		chatgpt_account_id?: string;
	};
	[key: string]: unknown;
}

function base64UrlEncode(buffer: Buffer): string {
	return buffer
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

function base64UrlDecode(value: string): string {
	const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`;
	return Buffer.from(
		padded.replace(/-/g, "+").replace(/_/g, "/"),
		"base64",
	).toString("utf8");
}

function generatePkce(): { verifier: string; challenge: string } {
	const verifier = base64UrlEncode(randomBytes(32));
	const challenge = base64UrlEncode(
		createHash("sha256").update(verifier).digest(),
	);
	return { verifier, challenge };
}

function createState(): string {
	return base64UrlEncode(randomBytes(32));
}

function safeTimingEqual(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function parseOpenAICodexAuthorizationInput(input: string): {
	code?: string;
	state?: string;
} {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// Not a full URL.
	}

	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	return { code: value };
}

function decodeJwt(token: string): CodexJwtPayload | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3 || !parts[1]) return null;
		return JSON.parse(base64UrlDecode(parts[1])) as CodexJwtPayload;
	} catch {
		return null;
	}
}

export function extractOpenAICodexAccountId(
	accessToken: string,
): string | null {
	const payload = decodeJwt(accessToken);
	const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
	return typeof accountId === "string" && accountId.trim().length > 0
		? accountId.trim()
		: null;
}

function buildAuthorizationUrl(state: string, challenge: string): string {
	const url = new URL(AUTHORIZE_URL);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", CLIENT_ID);
	url.searchParams.set("redirect_uri", REDIRECT_URI);
	url.searchParams.set("scope", SCOPE);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", state);
	url.searchParams.set("id_token_add_organizations", "true");
	url.searchParams.set("codex_cli_simplified_flow", "true");
	url.searchParams.set("originator", ORIGINATOR);
	return url.toString();
}

async function exchangeAuthorizationCode(
	code: string,
	verifier: string,
): Promise<OAuthCredentials> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			code_verifier: verifier,
			redirect_uri: REDIRECT_URI,
		}).toString(),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(
			`OpenAI Codex token exchange failed (${response.status}): ${text}`,
		);
	}

	const payload = (await response.json()) as TokenResponse;
	if (!payload.access_token || !payload.refresh_token) {
		throw new Error("OpenAI Codex token response was missing OAuth tokens");
	}

	const accountId = extractOpenAICodexAccountId(payload.access_token);
	if (!accountId) {
		throw new Error("OpenAI Codex token response did not include account id");
	}

	return {
		type: "oauth",
		access: payload.access_token,
		refresh: payload.refresh_token,
		expires: Date.now() + (payload.expires_in ?? 3600) * 1000,
		metadata: {
			mode: "openai-codex",
			accountId,
			scopes: SCOPE.split(" "),
		},
	};
}

async function refreshAccessToken(
	refreshToken: string,
): Promise<OAuthCredentials> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			client_id: CLIENT_ID,
			refresh_token: refreshToken,
		}).toString(),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(
			`OpenAI Codex token refresh failed (${response.status}): ${text}`,
		);
	}

	const payload = (await response.json()) as TokenResponse;
	if (!payload.access_token || !payload.refresh_token) {
		throw new Error("OpenAI Codex refresh response was missing OAuth tokens");
	}

	const accountId = extractOpenAICodexAccountId(payload.access_token);
	if (!accountId) {
		throw new Error("OpenAI Codex refresh response did not include account id");
	}

	return {
		type: "oauth",
		access: payload.access_token,
		refresh: payload.refresh_token,
		expires: Date.now() + (payload.expires_in ?? 3600) * 1000,
		metadata: {
			mode: "openai-codex",
			accountId,
			scopes: SCOPE.split(" "),
		},
	};
}

async function startCallbackServer(state: string): Promise<{
	server: Server | null;
	getCode: () => Promise<string | null>;
}> {
	return new Promise((resolve) => {
		let settleCode: (code: string | null) => void;
		const codePromise = new Promise<string | null>((codeResolve) => {
			settleCode = codeResolve;
		});

		const server = createServer((req: IncomingMessage, res: ServerResponse) => {
			const reqUrl = new URL(req.url ?? "", CALLBACK_ORIGIN);
			if (reqUrl.pathname !== "/auth/callback") {
				res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
				res.end("<html><body><h1>Not Found</h1></body></html>");
				return;
			}

			const error = reqUrl.searchParams.get("error");
			const errorDescription = reqUrl.searchParams.get("error_description");
			if (error) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(
					`<html><body><h1>Authentication Failed</h1><p>${escapeHtml(error)}</p><p>${escapeHtml(errorDescription ?? "")}</p></body></html>`,
				);
				settleCode(null);
				return;
			}

			const code = reqUrl.searchParams.get("code");
			const returnedState = reqUrl.searchParams.get("state");
			if (!code || !returnedState || !safeTimingEqual(returnedState, state)) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(
					"<html><body><h1>Authentication Failed</h1><p>Invalid OAuth callback.</p></body></html>",
				);
				settleCode(null);
				return;
			}

			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(
				"<html><body><h1>Login Successful</h1><p>You can close this tab and return to Maestro.</p></body></html>",
			);
			settleCode(code);
		});

		server.once("error", (error: NodeJS.ErrnoException) => {
			logger.warn("OpenAI Codex OAuth callback server unavailable", {
				code: error.code,
				message: error.message,
			});
			settleCode(null);
			resolve({ server: null, getCode: () => codePromise });
		});

		server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
			resolve({ server, getCode: () => codePromise });
		});
	});
}

async function waitForPromptCode(
	onPromptCode: () => Promise<string>,
	state: string,
): Promise<string | null> {
	const input = await onPromptCode();
	const parsed = parseOpenAICodexAuthorizationInput(input);
	if (parsed.state && !safeTimingEqual(parsed.state, state)) {
		throw new Error("State mismatch in OpenAI Codex OAuth callback");
	}
	return parsed.code ?? null;
}

export async function loginOpenAICodex(
	onAuthUrl: (url: string) => void,
	onPromptCode?: () => Promise<string>,
	onStatus?: (status: string) => void,
): Promise<void> {
	const { verifier, challenge } = generatePkce();
	const state = createState();
	const authUrl = buildAuthorizationUrl(state, challenge);
	const callback = await startCallbackServer(state);
	let timeout: ReturnType<typeof setTimeout> | undefined;

	try {
		onAuthUrl(authUrl);
		onStatus?.(
			callback.server
				? "Complete OpenAI login in the browser, or paste the redirect URL/code if prompted."
				: "Callback server unavailable. Paste the OpenAI redirect URL or authorization code.",
		);

		const timeoutPromise = new Promise<never>((_, reject) => {
			timeout = setTimeout(() => {
				reject(new Error("OpenAI Codex OAuth login timed out"));
			}, LOGIN_TIMEOUT_MS);
		});

		let code: string | null;
		if (!callback.server && onPromptCode) {
			code = await Promise.race([
				waitForPromptCode(onPromptCode, state),
				timeoutPromise,
			]);
		} else {
			code = await Promise.race([callback.getCode(), timeoutPromise]);
			if (!code && onPromptCode) {
				code = await Promise.race([
					waitForPromptCode(onPromptCode, state),
					timeoutPromise,
				]);
			}
		}

		if (!code) {
			throw new Error(
				onPromptCode
					? "Missing OpenAI Codex authorization code"
					: "OpenAI Codex OAuth did not receive a callback. Try again with a manual code prompt.",
			);
		}

		onStatus?.("Exchanging OpenAI Codex authorization code...");
		const credentials = await exchangeAuthorizationCode(code, verifier);
		saveOAuthCredentials("openai-codex", credentials);
		onStatus?.("OpenAI Codex credentials saved.");
	} finally {
		if (timeout) {
			clearTimeout(timeout);
		}
		callback.server?.close();
	}
}

export async function refreshOpenAICodexToken(
	refreshToken: string,
	metadata?: Record<string, unknown>,
): Promise<OAuthCredentials> {
	const refreshed = await refreshAccessToken(refreshToken);
	return {
		...refreshed,
		metadata: {
			...(metadata ?? {}),
			...refreshed.metadata,
			mode: "openai-codex",
		},
	};
}
