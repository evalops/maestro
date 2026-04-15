import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("Stream Idle Timeout", () => {
	// Note: We use real timers with short timeouts for reliable testing
	// across different test runners (vitest, bun test)

	describe("StreamIdleTimeoutError", () => {
		it("should create error with correct properties", async () => {
			const { StreamIdleTimeoutError } = await import(
				"../../src/providers/stream-idle-timeout.js"
			);

			const error = new StreamIdleTimeoutError(30000, "anthropic");

			expect(error.name).toBe("StreamIdleTimeoutError");
			expect(error.idleMs).toBe(30000);
			expect(error.provider).toBe("anthropic");
			expect(error.retryable).toBe(true);
			expect(error.message).toContain("30s");
			expect(error.message).toContain("anthropic");
		});
	});

	describe("isStreamIdleTimeoutError", () => {
		it("should return true for StreamIdleTimeoutError", async () => {
			const { StreamIdleTimeoutError, isStreamIdleTimeoutError } = await import(
				"../../src/providers/stream-idle-timeout.js"
			);

			const error = new StreamIdleTimeoutError(30000, "anthropic");
			expect(isStreamIdleTimeoutError(error)).toBe(true);
		});

		it("should return false for other errors", async () => {
			const { isStreamIdleTimeoutError } = await import(
				"../../src/providers/stream-idle-timeout.js"
			);

			expect(isStreamIdleTimeoutError(new Error("Some error"))).toBe(false);
			expect(isStreamIdleTimeoutError("string error")).toBe(false);
			expect(isStreamIdleTimeoutError(null)).toBe(false);
			expect(isStreamIdleTimeoutError(undefined)).toBe(false);
		});
	});

	describe("createTimeoutReader", () => {
		it("should pass through normal reads", async () => {
			const { createTimeoutReader } = await import(
				"../../src/providers/stream-idle-timeout.js"
			);

			// Create a mock reader
			let readCount = 0;
			const mockReader = {
				read: vi.fn(async () => {
					readCount++;
					if (readCount <= 3) {
						return { done: false, value: new Uint8Array([readCount]) };
					}
					return { done: true, value: undefined };
				}),
				releaseLock: vi.fn(),
				cancel: vi.fn(async () => {}),
				closed: Promise.resolve(undefined),
			} as unknown as ReadableStreamDefaultReader<Uint8Array>;

			const reader = createTimeoutReader(mockReader, {
				provider: "anthropic",
				timeoutMs: 1000,
			});

			const results: Uint8Array[] = [];
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				results.push(value);
			}

			expect(results).toHaveLength(3);
			expect(mockReader.read).toHaveBeenCalledTimes(4);
		});

		it("should throw StreamIdleTimeoutError when idle", async () => {
			const { createTimeoutReader, StreamIdleTimeoutError } = await import(
				"../../src/providers/stream-idle-timeout.js"
			);

			// Create a mock reader that never resolves
			const neverResolve = new Promise<ReadableStreamReadResult<Uint8Array>>(
				() => {},
			);
			const mockReader = {
				read: vi.fn(() => neverResolve),
				releaseLock: vi.fn(),
				cancel: vi.fn(async () => {}),
				closed: Promise.resolve(undefined),
			} as unknown as ReadableStreamDefaultReader<Uint8Array>;

			const reader = createTimeoutReader(mockReader, {
				provider: "anthropic",
				timeoutMs: 50, // Short timeout for testing
			});

			vi.useFakeTimers();
			try {
				const readPromise = reader.read();
				const assertion = expect(readPromise).rejects.toThrow(
					StreamIdleTimeoutError,
				);
				await vi.advanceTimersByTimeAsync(50);
				await assertion;
			} finally {
				vi.useRealTimers();
			}
		}, 5000);

		it("should respect abort signal", async () => {
			const { createTimeoutReader } = await import(
				"../../src/providers/stream-idle-timeout.js"
			);

			const controller = new AbortController();
			controller.abort();

			const mockReader = {
				read: vi.fn(async () => ({ done: false, value: new Uint8Array([1]) })),
				releaseLock: vi.fn(),
				cancel: vi.fn(async () => {}),
				closed: Promise.resolve(undefined),
			} as unknown as ReadableStreamDefaultReader<Uint8Array>;

			const reader = createTimeoutReader(mockReader, {
				provider: "anthropic",
				timeoutMs: 100,
				signal: controller.signal,
			});

			await expect(reader.read()).rejects.toThrow();
		});

		it("should clean up timeout on releaseLock", async () => {
			const { createTimeoutReader } = await import(
				"../../src/providers/stream-idle-timeout.js"
			);

			const mockReader = {
				read: vi.fn(async () => ({ done: true, value: undefined })),
				releaseLock: vi.fn(),
				cancel: vi.fn(async () => {}),
				closed: Promise.resolve(undefined),
			} as unknown as ReadableStreamDefaultReader<Uint8Array>;

			const reader = createTimeoutReader(mockReader, {
				provider: "anthropic",
				timeoutMs: 100,
			});

			reader.releaseLock();

			expect(mockReader.releaseLock).toHaveBeenCalled();
		});
	});

	describe("withIdleTimeout", () => {
		it("should pass through normal iteration", async () => {
			const { withIdleTimeout } = await import(
				"../../src/providers/stream-idle-timeout.js"
			);

			async function* source() {
				yield 1;
				yield 2;
				yield 3;
			}

			const results: number[] = [];
			for await (const value of withIdleTimeout(source(), {
				provider: "anthropic",
				timeoutMs: 1000,
			})) {
				results.push(value);
			}

			expect(results).toEqual([1, 2, 3]);
		});

		it("should throw StreamIdleTimeoutError when idle", async () => {
			const { withIdleTimeout, StreamIdleTimeoutError } = await import(
				"../../src/providers/stream-idle-timeout.js"
			);

			// Use an async iterable that blocks on second iteration
			const iterable = {
				[Symbol.asyncIterator]: () => {
					let count = 0;
					return {
						next: async () => {
							count++;
							if (count === 1) {
								return { done: false, value: 1 };
							}
							// Block forever on second call
							await new Promise(() => {});
							return { done: true, value: undefined };
						},
					};
				},
			};

			const timedSource = withIdleTimeout(iterable, {
				provider: "google",
				timeoutMs: 50, // Short timeout for testing
			});

			const iterator = timedSource[Symbol.asyncIterator]();

			// First value should come through
			const first = await iterator.next();
			expect(first.done).toBe(false);
			expect(first.value).toBe(1);

			// Second call should timeout
			vi.useFakeTimers();
			try {
				const nextPromise = iterator.next();
				const assertion = expect(nextPromise).rejects.toBeInstanceOf(
					StreamIdleTimeoutError,
				);
				await vi.advanceTimersByTimeAsync(50);
				await assertion;
			} finally {
				vi.useRealTimers();
			}
		}, 5000);
	});

	describe("withAbortableIdleTimeout", () => {
		it("should pass through normal iteration", async () => {
			const { withAbortableIdleTimeout } = await import(
				"../../src/providers/stream-idle-timeout.js"
			);

			async function* source() {
				yield "a";
				yield "b";
				yield "c";
			}

			const results: string[] = [];
			for await (const value of withAbortableIdleTimeout(source(), {
				provider: "openai",
				timeoutMs: 1000,
			})) {
				results.push(value);
			}

			expect(results).toEqual(["a", "b", "c"]);
		});

		it("should throw StreamIdleTimeoutError when idle", async () => {
			const { withAbortableIdleTimeout, StreamIdleTimeoutError } = await import(
				"../../src/providers/stream-idle-timeout.js"
			);

			// Use an async iterable that blocks on second iteration
			const iterable = {
				[Symbol.asyncIterator]: () => {
					let count = 0;
					return {
						next: async () => {
							count++;
							if (count === 1) {
								return { done: false, value: "first" };
							}
							// Block forever on second call
							await new Promise(() => {});
							return { done: true, value: undefined };
						},
					};
				},
			};

			const timedSource = withAbortableIdleTimeout(iterable, {
				provider: "bedrock",
				timeoutMs: 50, // Short timeout for testing
			});

			const iterator = timedSource[Symbol.asyncIterator]();

			// First value should come through
			const first = await iterator.next();
			expect(first.done).toBe(false);
			expect(first.value).toBe("first");

			// Second call should timeout
			vi.useFakeTimers();
			try {
				const nextPromise = iterator.next();
				const assertion = expect(nextPromise).rejects.toBeInstanceOf(
					StreamIdleTimeoutError,
				);
				await vi.advanceTimersByTimeAsync(50);
				await assertion;
			} finally {
				vi.useRealTimers();
			}
		}, 5000);

		it("should respect abort signal", async () => {
			const { withAbortableIdleTimeout } = await import(
				"../../src/providers/stream-idle-timeout.js"
			);

			const controller = new AbortController();

			async function* source() {
				yield "a";
				await new Promise((resolve) => setTimeout(resolve, 100));
				yield "b";
			}

			const timedSource = withAbortableIdleTimeout(source(), {
				provider: "openai",
				timeoutMs: 1000,
				signal: controller.signal,
			});

			const results: string[] = [];
			const iteratePromise = (async () => {
				for await (const value of timedSource) {
					results.push(value);
					if (results.length === 1) {
						controller.abort();
					}
				}
			})();

			await expect(iteratePromise).rejects.toThrow();
			expect(results).toEqual(["a"]);
		});

		it("should throw immediately if signal already aborted", async () => {
			const { withAbortableIdleTimeout } = await import(
				"../../src/providers/stream-idle-timeout.js"
			);

			const controller = new AbortController();
			controller.abort();

			async function* source() {
				yield "a";
			}

			const timedSource = withAbortableIdleTimeout(source(), {
				provider: "openai",
				timeoutMs: 1000,
				signal: controller.signal,
			});

			let errorThrown = false;
			try {
				for await (const _value of timedSource) {
					// Should not reach here
				}
			} catch (error) {
				errorThrown = true;
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).name).toBe("AbortError");
			}
			expect(errorThrown).toBe(true);
		});
	});

	describe("integration with network config", () => {
		it("should use provider config for timeout if not specified", async () => {
			// This test verifies that the timeout wrapper uses the
			// provider's streamIdleTimeout config by default

			const { withIdleTimeout } = await import(
				"../../src/providers/stream-idle-timeout.js"
			);
			const { getProviderNetworkConfig } = await import(
				"../../src/providers/network-config.js"
			);

			const config = getProviderNetworkConfig("anthropic");
			expect(config.streamIdleTimeout).toBe(300_000);

			// The wrapper should use the provider config if timeoutMs is not specified
			// We can't easily test the actual timeout value without mocking,
			// but we verify the function doesn't throw when called
			async function* source() {
				yield "test";
			}

			const results: string[] = [];
			for await (const value of withIdleTimeout(source(), {
				provider: "anthropic",
				// No timeoutMs specified - should use config
			})) {
				results.push(value);
			}

			expect(results).toEqual(["test"]);
		});
	});
});
