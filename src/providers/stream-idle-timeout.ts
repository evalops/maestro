/**
 * Stream Idle Timeout Utilities
 *
 * Provides utilities to detect stalled streams that stop receiving data.
 * This addresses scenarios where:
 * - Network connection degrades but doesn't fully drop
 * - Server gets stuck processing but doesn't close connection
 * - Proxy keeps connection alive without data
 *
 * @module providers/stream-idle-timeout
 */

import type { ReadableStreamReadResult } from "node:stream/web";

import type { Provider } from "../agent/types.js";
import { createLogger } from "../utils/logger.js";
import { getProviderNetworkConfig } from "./network-config.js";

const logger = createLogger("providers:stream-idle-timeout");

/**
 * Error thrown when a stream hasn't received data within the configured timeout.
 * This error is marked as retryable - the transport layer will automatically retry
 * the stream up to `streamMaxRetries` times (default: 5) with exponential backoff.
 *
 * Providers re-throw this error to allow the transport layer to handle retries.
 * Configure retry behavior via `streamMaxRetries` in network-config.ts or
 * the COMPOSER_STREAM_MAX_RETRIES environment variable.
 */
export class StreamIdleTimeoutError extends Error {
	readonly name = "StreamIdleTimeoutError";
	/** Indicates this error is safe to retry. Transport layer handles retries automatically. */
	readonly retryable = true;

	constructor(
		public readonly idleMs: number,
		public readonly provider: Provider,
	) {
		super(
			`Stream idle timeout: no data received for ${Math.round(idleMs / 1000)}s from ${provider}`,
		);
	}
}

/**
 * Check if an error is a StreamIdleTimeoutError
 */
export function isStreamIdleTimeoutError(
	error: unknown,
): error is StreamIdleTimeoutError {
	return error instanceof StreamIdleTimeoutError;
}

/**
 * Options for idle timeout wrappers
 */
export interface IdleTimeoutOptions {
	/** Provider name for logging and config lookup */
	provider: Provider;
	/** Override the default idle timeout (ms). If not specified, uses provider config. */
	timeoutMs?: number;
	/** AbortSignal to cancel the stream */
	signal?: AbortSignal;
}

/**
 * Creates a reader wrapper that enforces idle timeout on ReadableStream reads.
 *
 * Use this for providers that use raw fetch streaming (Anthropic, OpenAI completions).
 *
 * @example
 * ```typescript
 * const reader = response.body.getReader();
 * const timeoutReader = createTimeoutReader(reader, { provider: 'anthropic' });
 *
 * while (true) {
 *   const { done, value } = await timeoutReader.read();
 *   if (done) break;
 *   // process value
 * }
 * ```
 */
export function createTimeoutReader<T>(
	reader: ReadableStreamDefaultReader<T>,
	options: IdleTimeoutOptions,
): ReadableStreamDefaultReader<T> {
	const config = getProviderNetworkConfig(options.provider);
	const timeoutMs = options.timeoutMs ?? config.streamIdleTimeout;

	let timeoutId: ReturnType<typeof setTimeout> | null = null;

	const clearIdleTimeout = (): void => {
		if (timeoutId !== null) {
			clearTimeout(timeoutId);
			timeoutId = null;
		}
	};

	const startIdleTimeout = (): Promise<never> => {
		return new Promise((_, reject) => {
			timeoutId = setTimeout(() => {
				const error = new StreamIdleTimeoutError(timeoutMs, options.provider);
				logger.warn("Stream idle timeout", {
					provider: options.provider,
					timeoutMs,
				});
				reject(error);
			}, timeoutMs);
		});
	};

	// Handle external abort
	const onAbort = (): void => {
		clearIdleTimeout();
	};

	if (options.signal) {
		if (options.signal.aborted) {
			// Already aborted, just return a reader that will throw
			return {
				read: () => {
					const error = new Error("Aborted before read", { cause: "abort" });
					error.name = "AbortError";
					return Promise.reject(error);
				},
				releaseLock: () => reader.releaseLock(),
				cancel: (reason?: unknown) => reader.cancel(reason),
				closed: reader.closed,
			};
		}
		options.signal.addEventListener("abort", onAbort, { once: true });
	}

	return {
		async read(): Promise<ReadableStreamReadResult<T>> {
			clearIdleTimeout();

			try {
				// Race between the actual read and the idle timeout
				const result = await Promise.race([reader.read(), startIdleTimeout()]);

				clearIdleTimeout();

				// If done, clean up
				if (result.done) {
					if (options.signal) {
						options.signal.removeEventListener("abort", onAbort);
					}
				}

				return result;
			} catch (error) {
				clearIdleTimeout();
				if (options.signal) {
					options.signal.removeEventListener("abort", onAbort);
				}
				throw error;
			}
		},

		releaseLock(): void {
			clearIdleTimeout();
			if (options.signal) {
				options.signal.removeEventListener("abort", onAbort);
			}
			reader.releaseLock();
		},

		cancel(reason?: unknown): Promise<void> {
			clearIdleTimeout();
			if (options.signal) {
				options.signal.removeEventListener("abort", onAbort);
			}
			return reader.cancel(reason);
		},

		get closed(): Promise<void> {
			return reader.closed;
		},
	};
}

/**
 * Wraps an AsyncIterable with idle timeout detection.
 *
 * Use this for providers that use SDK-based streaming (Google, Bedrock, OpenAI Responses).
 *
 * @example
 * ```typescript
 * const stream = await client.models.generateContentStream(params);
 * const timedStream = withIdleTimeout(stream, { provider: 'google' });
 *
 * for await (const chunk of timedStream) {
 *   // process chunk
 * }
 * ```
 */
export async function* withIdleTimeout<T>(
	iterable: AsyncIterable<T>,
	options: IdleTimeoutOptions,
): AsyncGenerator<T, void, unknown> {
	const config = getProviderNetworkConfig(options.provider);
	const timeoutMs = options.timeoutMs ?? config.streamIdleTimeout;

	const iterator = iterable[Symbol.asyncIterator]();
	let timeoutId: ReturnType<typeof setTimeout> | null = null;

	const clearIdleTimeout = (): void => {
		if (timeoutId !== null) {
			clearTimeout(timeoutId);
			timeoutId = null;
		}
	};

	try {
		while (true) {
			// Check for abort before each iteration
			if (options.signal?.aborted) {
				const error = new Error("Aborted", { cause: "abort" });
				error.name = "AbortError";
				throw error;
			}

			// Create timeout promise
			const timeoutPromise = new Promise<never>((_, reject) => {
				timeoutId = setTimeout(() => {
					const error = new StreamIdleTimeoutError(timeoutMs, options.provider);
					logger.warn("Stream idle timeout", {
						provider: options.provider,
						timeoutMs,
					});
					reject(error);
				}, timeoutMs);
			});

			// Race between next item and timeout
			let result: IteratorResult<T>;
			try {
				result = await Promise.race([iterator.next(), timeoutPromise]);
				clearIdleTimeout();
			} catch (error) {
				clearIdleTimeout();
				throw error;
			}

			if (result.done) {
				return;
			}

			yield result.value;
		}
	} finally {
		clearIdleTimeout();
		// Ensure iterator is properly closed
		if (iterator.return) {
			try {
				await iterator.return();
			} catch {
				// Ignore errors during cleanup
			}
		}
	}
}

/**
 * Creates an abort-aware idle timeout wrapper for async iterables.
 *
 * This version integrates with AbortSignal to ensure proper cleanup
 * when the operation is cancelled.
 *
 * @example
 * ```typescript
 * const controller = new AbortController();
 * const stream = await client.responses.create(params);
 * const timedStream = withAbortableIdleTimeout(stream, {
 *   provider: 'openai',
 *   signal: controller.signal
 * });
 *
 * for await (const event of timedStream) {
 *   // process event
 * }
 * ```
 */
export async function* withAbortableIdleTimeout<T>(
	iterable: AsyncIterable<T>,
	options: IdleTimeoutOptions,
): AsyncGenerator<T, void, unknown> {
	const config = getProviderNetworkConfig(options.provider);
	const timeoutMs = options.timeoutMs ?? config.streamIdleTimeout;

	const iterator = iterable[Symbol.asyncIterator]();
	let timeoutId: ReturnType<typeof setTimeout> | null = null;
	let abortHandler: (() => void) | null = null;

	const cleanup = (): void => {
		if (timeoutId !== null) {
			clearTimeout(timeoutId);
			timeoutId = null;
		}
		if (abortHandler && options.signal) {
			options.signal.removeEventListener("abort", abortHandler);
			abortHandler = null;
		}
	};

	try {
		while (true) {
			// Check for abort before each iteration
			if (options.signal?.aborted) {
				const error = new Error("Aborted");
				error.name = "AbortError";
				throw error;
			}

			// Create timeout and abort promises
			const timeoutPromise = new Promise<never>((_, reject) => {
				timeoutId = setTimeout(() => {
					const error = new StreamIdleTimeoutError(timeoutMs, options.provider);
					logger.warn("Stream idle timeout", {
						provider: options.provider,
						timeoutMs,
					});
					reject(error);
				}, timeoutMs);
			});

			const abortPromise = new Promise<never>((_, reject) => {
				if (options.signal) {
					abortHandler = () => {
						const error = new Error("Aborted");
						error.name = "AbortError";
						reject(error);
					};
					options.signal.addEventListener("abort", abortHandler, {
						once: true,
					});
				}
			});

			// Race between next item, timeout, and abort
			let result: IteratorResult<T>;
			try {
				const promises: Promise<IteratorResult<T> | never>[] = [
					iterator.next(),
					timeoutPromise,
				];
				if (options.signal) {
					promises.push(abortPromise);
				}
				result = (await Promise.race(promises)) as IteratorResult<T>;
				cleanup();
			} catch (error) {
				cleanup();
				throw error;
			}

			if (result.done) {
				return;
			}

			yield result.value;
		}
	} finally {
		cleanup();
		// Ensure iterator is properly closed
		if (iterator.return) {
			try {
				await iterator.return();
			} catch {
				// Ignore errors during cleanup
			}
		}
	}
}
