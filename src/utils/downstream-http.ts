import { createLogger } from "./logger.js";
import { parseRetryAfter } from "./retry.js";

const logger = createLogger("runtime:downstream-http");

export type DownstreamFailureMode = "required" | "optional";

export interface DownstreamFetchOptions {
	serviceName: string;
	failureMode: DownstreamFailureMode;
	timeoutMs: number;
	maxAttempts?: number;
	initialDelayMs?: number;
	maxDelayMs?: number;
	fetchImpl?: typeof fetch;
	sleepMs?: (delayMs: number) => Promise<void>;
	shouldRetryStatus?: (status: number) => boolean;
}

export class DownstreamHttpError extends Error {
	constructor(
		message: string,
		public readonly serviceName: string,
		public readonly failureMode: DownstreamFailureMode,
		public readonly retryable: boolean,
		public readonly timeoutMs?: number,
	) {
		super(message);
		this.name = "DownstreamHttpError";
	}
}

function sleep(delayMs: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function defaultShouldRetryStatus(status: number): boolean {
	return status === 408 || status === 429 || status >= 500;
}

function isRetryableFetchError(error: Error): boolean {
	if (error.name === "AbortError") {
		return true;
	}

	const message = error.message.toLowerCase();
	return (
		message.includes("timeout") ||
		message.includes("network") ||
		message.includes("econnreset") ||
		message.includes("etimedout") ||
		message.includes("econnrefused") ||
		message.includes("socket hang up") ||
		message.includes("fetch failed")
	);
}

function normalizePositiveInt(
	value: number | undefined,
	fallback: number,
): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.max(1, Math.trunc(value));
}

function normalizeDelay(value: number | undefined, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return fallback;
	}
	return Math.trunc(value);
}

function combineAbortSignals(signals: AbortSignal[]): AbortSignal {
	const controller = new AbortController();
	const abortFrom = (signal: AbortSignal) => {
		if (!controller.signal.aborted) {
			controller.abort(signal.reason);
		}
	};

	for (const signal of signals) {
		if (signal.aborted) {
			abortFrom(signal);
			break;
		}
		signal.addEventListener("abort", () => abortFrom(signal), { once: true });
	}

	return controller.signal;
}

function collectRetryHeaders(response: Response): Record<string, string> {
	const headers: Record<string, string> = {};
	const retryAfter = response.headers.get("retry-after");
	const retryAfterMs = response.headers.get("retry-after-ms");
	if (retryAfter) {
		headers["retry-after"] = retryAfter;
	}
	if (retryAfterMs) {
		headers["retry-after-ms"] = retryAfterMs;
	}
	return headers;
}

function retryDelayMs(
	response: Response,
	attemptIndex: number,
	initialDelayMs: number,
	maxDelayMs: number,
): number {
	const retryAfterMs = parseRetryAfter(collectRetryHeaders(response));
	if (retryAfterMs !== null) {
		return Math.min(retryAfterMs, maxDelayMs);
	}

	return Math.min(initialDelayMs * 2 ** attemptIndex, maxDelayMs);
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function timeoutError(
	serviceName: string,
	failureMode: DownstreamFailureMode,
	timeoutMs: number,
): DownstreamHttpError {
	return new DownstreamHttpError(
		`${serviceName} request timed out after ${timeoutMs}ms`,
		serviceName,
		failureMode,
		true,
		timeoutMs,
	);
}

function requestError(
	serviceName: string,
	failureMode: DownstreamFailureMode,
	error: Error,
	retryable: boolean,
): DownstreamHttpError {
	return new DownstreamHttpError(
		`${serviceName} request failed: ${error.message}`,
		serviceName,
		failureMode,
		retryable,
	);
}

export async function fetchDownstream(
	input: Parameters<typeof fetch>[0],
	init: RequestInit,
	options: DownstreamFetchOptions,
): Promise<Response> {
	const maxAttempts = normalizePositiveInt(options.maxAttempts, 2);
	const initialDelayMs = normalizeDelay(options.initialDelayMs, 100);
	const maxDelayMs = normalizeDelay(options.maxDelayMs, 1_000);
	const timeoutMs = normalizePositiveInt(options.timeoutMs, 2_000);
	const fetchImpl = options.fetchImpl ?? fetch;
	const sleepImpl = options.sleepMs ?? sleep;
	const shouldRetryStatus =
		options.shouldRetryStatus ?? defaultShouldRetryStatus;
	const externalSignal = init.signal;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const timeoutController = new AbortController();
		const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
		const signal = externalSignal
			? combineAbortSignals([externalSignal, timeoutController.signal])
			: timeoutController.signal;

		try {
			const response = await fetchImpl(input, { ...init, signal });
			clearTimeout(timeout);

			if (
				response.ok ||
				!shouldRetryStatus(response.status) ||
				attempt >= maxAttempts
			) {
				return response;
			}

			const delayMs = retryDelayMs(
				response,
				attempt - 1,
				initialDelayMs,
				maxDelayMs,
			);
			logger.debug("Retrying downstream request after status", {
				serviceName: options.serviceName,
				failureMode: options.failureMode,
				status: response.status,
				attempt,
				maxAttempts,
				delayMs,
			});
			await sleepImpl(delayMs);
		} catch (error) {
			clearTimeout(timeout);
			const normalized = toError(error);
			const timedOut = timeoutController.signal.aborted;
			if (externalSignal?.aborted && !timedOut) {
				throw normalized;
			}

			const retryable = timedOut || isRetryableFetchError(normalized);
			const wrapped = timedOut
				? timeoutError(options.serviceName, options.failureMode, timeoutMs)
				: requestError(
						options.serviceName,
						options.failureMode,
						normalized,
						retryable,
					);

			if (!retryable || attempt >= maxAttempts) {
				throw wrapped;
			}

			const delayMs = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
			logger.debug("Retrying downstream request after error", {
				serviceName: options.serviceName,
				failureMode: options.failureMode,
				error: wrapped.message,
				attempt,
				maxAttempts,
				delayMs,
			});
			await sleepImpl(delayMs);
		}
	}

	throw new DownstreamHttpError(
		`${options.serviceName} request failed after ${maxAttempts} attempts`,
		options.serviceName,
		options.failureMode,
		true,
	);
}
