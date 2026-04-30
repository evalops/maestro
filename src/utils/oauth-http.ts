import { fetchDownstream } from "./downstream-http.js";

const DEFAULT_OAUTH_HTTP_MAX_ATTEMPTS = 1;
const DEFAULT_OAUTH_HTTP_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS_ENV_VARS = [
	"MAESTRO_OAUTH_HTTP_MAX_ATTEMPTS",
	"OAUTH_HTTP_MAX_ATTEMPTS",
] as const;
const TIMEOUT_ENV_VARS = [
	"MAESTRO_OAUTH_HTTP_TIMEOUT_MS",
	"OAUTH_HTTP_TIMEOUT_MS",
] as const;

interface OAuthHttpOptions {
	maxAttempts?: number;
	serviceName: string;
	timeoutMs?: number;
}

function getEnvPositiveInt(names: readonly string[], fallback: number): number {
	for (const name of names) {
		const value = process.env[name]?.trim();
		if (!value) {
			continue;
		}
		const parsed = Number.parseInt(value, 10);
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed;
		}
	}
	return fallback;
}

function getOAuthHttpMaxAttempts(): number {
	return getEnvPositiveInt(
		MAX_ATTEMPTS_ENV_VARS,
		DEFAULT_OAUTH_HTTP_MAX_ATTEMPTS,
	);
}

function getOAuthHttpTimeoutMs(): number {
	return getEnvPositiveInt(TIMEOUT_ENV_VARS, DEFAULT_OAUTH_HTTP_TIMEOUT_MS);
}

export function fetchOAuthHttp(
	input: Parameters<typeof fetch>[0],
	init: RequestInit,
	options: OAuthHttpOptions,
): Promise<Response> {
	return fetchDownstream(input, init, {
		serviceName: options.serviceName,
		failureMode: "required",
		timeoutMs: options.timeoutMs ?? getOAuthHttpTimeoutMs(),
		maxAttempts: options.maxAttempts ?? getOAuthHttpMaxAttempts(),
		initialDelayMs: 100,
		maxDelayMs: 1_000,
	});
}
