import { recordToolExecution } from "../telemetry.js";
import { trackExaUsage } from "./exa-usage.js";

const EXA_API_BASE = "https://api.exa.ai";
const EXA_DEBUG = (process.env.EXA_DEBUG ?? "").toLowerCase();
const EXA_DEBUG_ENABLED = EXA_DEBUG === "1" || EXA_DEBUG === "true";
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429]);
const RETRYABLE_ERROR_SUBSTRINGS = [
	"ECONNRESET",
	"ENOTFOUND",
	"ETIMEDOUT",
	"fetch failed",
];

interface ExaErrorResponse {
	error?: {
		message?: string;
		type?: string;
		status?: number;
	};
	message?: string;
	requestId?: string;
	costDollars?: number | string | { total?: number };
}

export interface ExaTelemetryEvent {
	toolName?: string;
	operation?: string;
	endpoint: string;
	attempt: number;
	durationMs: number;
	status?: number;
	success: boolean;
	requestId?: string;
	costDollars?: number;
	errorMessage?: string;
	timestamp: number;
}

export interface CallExaOptions {
	toolName?: string;
	operation?: string;
	retries?: number;
	retryDelayMs?: number;
	onTelemetry?: (event: ExaTelemetryEvent) => void;
}

export class ExaApiError extends Error {
	readonly status?: number;
	readonly endpoint: string;
	readonly body?: string;
	readonly parsedError?: ExaErrorResponse;

	constructor(
		message: string,
		options: {
			endpoint: string;
			status?: number;
			body?: string;
			parsedError?: ExaErrorResponse;
		},
	) {
		super(message);
		this.name = "ExaApiError";
		this.status = options.status;
		this.endpoint = options.endpoint;
		this.body = options.body;
		this.parsedError = options.parsedError;
	}
}

function getExaApiKey(): string {
	const apiKey = process.env.EXA_API_KEY;
	if (!apiKey) {
		throw new Error(
			"EXA_API_KEY environment variable is required. Get your key at https://dashboard.exa.ai/api-keys",
		);
	}
	return apiKey;
}

function parseErrorResponse(rawBody?: string): ExaErrorResponse | undefined {
	if (!rawBody) return undefined;
	try {
		return JSON.parse(rawBody) as ExaErrorResponse;
	} catch {
		return undefined;
	}
}

function deriveErrorMessage(
	parsed: ExaErrorResponse | undefined,
	fallback: string,
	rawBody?: string,
): string {
	return parsed?.error?.message ?? parsed?.message ?? rawBody ?? fallback;
}

function isRetryableStatus(status?: number): boolean {
	if (typeof status !== "number") return false;
	if (status >= 500 && status < 600) {
		return true;
	}
	return RETRYABLE_STATUS_CODES.has(status);
}

function isRetryableNetworkError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return (
		RETRYABLE_ERROR_SUBSTRINGS.some((substring) =>
			error.message.toLowerCase().includes(substring),
		) || error.name === "AbortError"
	);
}

export function normalizeCostDollars(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) return undefined;
		try {
			const parsed = JSON.parse(trimmed) as { total?: number } | number;
			if (typeof parsed === "number") {
				return Number.isFinite(parsed) ? parsed : undefined;
			}
			const total = parsed?.total;
			return typeof total === "number" ? total : undefined;
		} catch {
			const numeric = Number(trimmed);
			return Number.isFinite(numeric) ? numeric : undefined;
		}
	}
	if (typeof value === "object" && value !== null) {
		const total = (value as { total?: number }).total;
		return typeof total === "number" ? total : undefined;
	}
	return undefined;
}

function emitTelemetry(
	onTelemetry: CallExaOptions["onTelemetry"],
	event: ExaTelemetryEvent,
): void {
	if (!onTelemetry) return;
	onTelemetry(event);
}

function reportExaTelemetry(event: ExaTelemetryEvent): void {
	const toolName = event.toolName ?? "exa";
	const metadata: Record<string, unknown> = {
		endpoint: event.endpoint,
		operation: event.operation,
		attempt: event.attempt,
		status: event.status,
		requestId: event.requestId,
		costDollars: event.costDollars,
	};
	recordToolExecution(toolName, event.success, event.durationMs, metadata);
	trackExaUsage(event);
}

function logExaDebug(message: string, payload?: unknown): void {
	if (!EXA_DEBUG_ENABLED) return;
	const suffix = payload ? ` ${JSON.stringify(payload)}` : "";
	console.error(`[exa] ${message}${suffix}`);
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

export async function callExa<T>(
	endpoint: string,
	body: unknown,
	options: CallExaOptions = {},
): Promise<T> {
	const apiKey = getExaApiKey();
	const retries = Math.max(0, options.retries ?? 0);
	const retryDelayMs = Math.max(0, options.retryDelayMs ?? 200);
	const telemetryHandler = options.onTelemetry ?? reportExaTelemetry;

	for (let attempt = 0; attempt <= retries; attempt++) {
		const attemptNumber = attempt + 1;
		const start = performance.now();
		let response: Response;
		let responseBody = "";
		try {
			if (EXA_DEBUG_ENABLED) {
				logExaDebug(`request ${endpoint}`, {
					attempt: attemptNumber,
					body,
				});
			}
			response = await fetch(`${EXA_API_BASE}${endpoint}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": apiKey,
				},
				body: JSON.stringify(body),
			});
			responseBody = await response.text();
			if (EXA_DEBUG_ENABLED) {
				logExaDebug(`response ${endpoint}`, {
					attempt: attemptNumber,
					status: response.status,
					body: responseBody.slice(0, 2000),
				});
			}
		} catch (error) {
			emitTelemetry(telemetryHandler, {
				toolName: options.toolName,
				operation: options.operation,
				endpoint,
				attempt: attemptNumber,
				durationMs: performance.now() - start,
				success: false,
				errorMessage: (error as Error)?.message,
				timestamp: Date.now(),
			});
			if (attempt < retries && isRetryableNetworkError(error)) {
				await wait(retryDelayMs * 2 ** attempt);
				continue;
			}
			throw error;
		}

		if (!response.ok) {
			const parsedError = parseErrorResponse(responseBody);
			const message = deriveErrorMessage(
				parsedError,
				response.statusText,
				responseBody,
			);
			const error = new ExaApiError(message, {
				endpoint,
				status: response.status,
				body: responseBody,
				parsedError,
			});

			emitTelemetry(telemetryHandler, {
				toolName: options.toolName,
				operation: options.operation,
				endpoint,
				attempt: attemptNumber,
				durationMs: performance.now() - start,
				status: response.status,
				success: false,
				errorMessage: message,
				requestId: parsedError?.requestId,
				costDollars: normalizeCostDollars(parsedError?.costDollars),
				timestamp: Date.now(),
			});

			if (attempt < retries && isRetryableStatus(response.status)) {
				await wait(retryDelayMs * 2 ** attempt);
				continue;
			}
			throw error;
		}

		const durationMs = performance.now() - start;
		if (!responseBody) {
			emitTelemetry(telemetryHandler, {
				toolName: options.toolName,
				operation: options.operation,
				endpoint,
				attempt: attemptNumber,
				durationMs,
				status: response.status,
				success: true,
				timestamp: Date.now(),
			});
			return {} as T;
		}

		try {
			const data = JSON.parse(responseBody) as T & {
				requestId?: string;
				costDollars?: unknown;
			};
			emitTelemetry(telemetryHandler, {
				toolName: options.toolName,
				operation: options.operation,
				endpoint,
				attempt: attemptNumber,
				durationMs,
				status: response.status,
				success: true,
				requestId: data.requestId,
				costDollars: normalizeCostDollars(data.costDollars),
				timestamp: Date.now(),
			});
			return data;
		} catch (error) {
			throw new Error(
				`Failed to parse Exa response: ${(error as Error).message}`,
			);
		}
	}

	throw new Error("Exa API request failed after retries");
}

