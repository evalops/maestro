import { arch, platform, release } from "node:os";
import { extractOpenAICodexAccountId } from "../../oauth/openai-codex.js";

export const DEFAULT_OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
export const OPENAI_CODEX_ORIGINATOR = "codex_cli_rs";

export interface ResolveOpenAICodexSessionOptions {
	token: string;
	modelBaseUrl?: string;
	modelHeaders?: Record<string, string>;
	optionHeaders?: Record<string, string>;
	sessionId?: string;
}

export interface OpenAICodexSession {
	url: string;
	accountId: string;
	headers: Headers;
}

export function resolveOpenAICodexUrl(baseUrl?: string): string {
	const raw =
		baseUrl && baseUrl.trim().length > 0
			? baseUrl
			: DEFAULT_OPENAI_CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/u, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

export function resolveOpenAICodexAccountId(
	token: string,
	headers: Record<string, string> | undefined,
): string {
	for (const [key, value] of Object.entries(headers ?? {})) {
		if (key.toLowerCase() === "chatgpt-account-id" && value.trim()) {
			return value.trim();
		}
	}
	const accountId =
		process.env.OPENAI_CODEX_ACCOUNT_ID?.trim() ??
		process.env.CHATGPT_ACCOUNT_ID?.trim() ??
		extractOpenAICodexAccountId(token);
	if (!accountId) {
		throw new Error(
			"OpenAI Codex account id is required. Log in with /login openai-codex or set OPENAI_CODEX_ACCOUNT_ID.",
		);
	}
	return accountId;
}

export function resolveOpenAICodexSession(
	options: ResolveOpenAICodexSessionOptions,
): OpenAICodexSession {
	const accountId = resolveOpenAICodexAccountId(
		options.token,
		options.optionHeaders,
	);
	const headers = new Headers(options.modelHeaders);
	for (const [key, value] of Object.entries(options.optionHeaders ?? {})) {
		headers.set(key, value);
	}
	headers.set("Authorization", `Bearer ${options.token}`);
	headers.set("chatgpt-account-id", accountId);
	headers.set("originator", OPENAI_CODEX_ORIGINATOR);
	headers.set("User-Agent", `maestro (${platform()} ${release()}; ${arch()})`);
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");
	if (options.sessionId) {
		headers.set("session_id", options.sessionId);
		headers.set("x-client-request-id", options.sessionId);
	}
	return {
		url: resolveOpenAICodexUrl(options.modelBaseUrl),
		accountId,
		headers,
	};
}
