/**
 * Async utilities for timeouts, debouncing, and concurrency control.
 */

import { createLogger } from "./logger.js";

const logger = createLogger("async-utils");

export class TimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TimeoutError";
	}
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a promise with a timeout
 */
export async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	errorMessage?: string,
): Promise<T> {
	let timeoutId: NodeJS.Timeout | undefined;

	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => {
			reject(
				new TimeoutError(
					errorMessage || `Operation timed out after ${timeoutMs}ms`,
				),
			);
		}, timeoutMs);
	});

	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId);
		}
	}
}

/**
 * Debounce async function calls
 */
export function debounce<TArgs extends unknown[], TResult>(
	fn: (...args: TArgs) => Promise<TResult>,
	delayMs: number,
): (...args: TArgs) => Promise<TResult> {
	let timeoutId: NodeJS.Timeout | null = null;
	let pendingPromise: Promise<TResult> | null = null;

	return (...args: TArgs): Promise<TResult> => {
		if (timeoutId) {
			clearTimeout(timeoutId);
		}

		if (pendingPromise) {
			return pendingPromise;
		}

		pendingPromise = new Promise((resolve, reject) => {
			timeoutId = setTimeout(async () => {
				try {
					const result = await fn(...args);
					resolve(result);
				} catch (error) {
					reject(error);
				} finally {
					pendingPromise = null;
					timeoutId = null;
				}
			}, delayMs);
		});

		return pendingPromise;
	};
}

/**
 * Execute promises in batches with concurrency limit
 */
export async function batchExecute<T, R>(
	items: T[],
	fn: (item: T) => Promise<R>,
	options: {
		concurrency?: number;
		onProgress?: (completed: number) => void;
	} = {},
): Promise<R[]> {
	const { concurrency = 5, onProgress } = options;
	const results: R[] = [];
	const executing: Promise<void>[] = [];
	let completed = 0;

	for (const item of items) {
		const promise = fn(item).then((result) => {
			results.push(result);
			completed++;
			if (onProgress) {
				onProgress(completed);
			}
		});

		executing.push(promise);

		if (executing.length >= concurrency) {
			await Promise.race(executing);
			executing.splice(
				executing.findIndex((p) => p === promise),
				1,
			);
		}
	}

	await Promise.all(executing);
	return results;
}

/**
 * Parallel execution with all settled results
 */
export async function allSettledWithDetails<T>(
	promises: Promise<T>[],
): Promise<{
	results: T[];
	errors: Error[];
	successful: number;
	failed: number;
}> {
	const settled = await Promise.allSettled(promises);

	const results: T[] = [];
	const errors: Error[] = [];

	for (const result of settled) {
		if (result.status === "fulfilled") {
			results.push(result.value);
		} else {
			errors.push(
				result.reason instanceof Error
					? result.reason
					: new Error(String(result.reason)),
			);
		}
	}

	return {
		results,
		errors,
		successful: results.length,
		failed: errors.length,
	};
}

/**
 * Create an AbortController that auto-aborts after timeout
 */
export function createTimeoutController(timeoutMs: number): AbortController {
	const controller = new AbortController();

	const timeoutId = setTimeout(() => {
		controller.abort();
	}, timeoutMs);

	// Clean up timeout if aborted manually
	controller.signal.addEventListener(
		"abort",
		() => {
			clearTimeout(timeoutId);
		},
		{ once: true },
	);

	return controller;
}

/**
 * Execute with AbortSignal support
 */
export async function withAbort<T>(
	fn: (signal: AbortSignal) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}

	return fn(signal || new AbortController().signal);
}

/**
 * Queue for sequential execution
 */
export class AsyncQueue {
	private queue: Array<() => Promise<void>> = [];
	private running = false;

	async add<T>(fn: () => Promise<T>): Promise<T> {
		return new Promise((resolve, reject) => {
			this.queue.push(async () => {
				try {
					const result = await fn();
					resolve(result);
				} catch (error) {
					reject(error);
				}
			});

			this.process();
		});
	}

	private async process(): Promise<void> {
		if (this.running || this.queue.length === 0) {
			return;
		}

		this.running = true;

		while (this.queue.length > 0) {
			const fn = this.queue.shift();
			if (fn) {
				try {
					await fn();
				} catch (error) {
					logger.error(
						"Queue task failed",
						error instanceof Error ? error : undefined,
					);
				}
			}
		}

		this.running = false;
	}

	clear(): void {
		this.queue = [];
	}

	get length(): number {
		return this.queue.length;
	}
}
