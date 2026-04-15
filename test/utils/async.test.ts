import { describe, expect, it, vi } from "vitest";
import {
	TimeoutError,
	batchExecute,
	withTimeout,
} from "../../src/utils/async.js";

describe("batchExecute", () => {
	it("waits for all tasks and respects concurrency", async () => {
		vi.useFakeTimers();
		try {
			const items = [0, 1, 2, 3];
			let inFlight = 0;
			let maxInFlight = 0;

			const run = batchExecute(
				items,
				async (item) => {
					inFlight += 1;
					maxInFlight = Math.max(maxInFlight, inFlight);
					await new Promise((resolve) =>
						setTimeout(resolve, item === 1 ? 50 : 10),
					);
					inFlight -= 1;
					return item;
				},
				{ concurrency: 2 },
			);

			await vi.advanceTimersByTimeAsync(100);
			const results = await run;

			expect(maxInFlight).toBeLessThanOrEqual(2);
			expect(results.sort((a, b) => a - b)).toEqual(items);
		} finally {
			vi.useRealTimers();
		}
	});

	it("returns results in the same order as items", async () => {
		const items = [10, 20, 30];
		const run = batchExecute(
			items,
			async (item) => {
				await new Promise((r) => setTimeout(r, item === 20 ? 50 : 10));
				return item;
			},
			{ concurrency: 2 },
		);
		const results = await run;
		expect(results).toEqual([10, 20, 30]);
	});
});

describe("withTimeout", () => {
	it("resolves with value when promise resolves before timeout", async () => {
		const result = await withTimeout(Promise.resolve(42), 1000);
		expect(result).toBe(42);
	});

	it("rejects with TimeoutError when timeout fires first", async () => {
		vi.useFakeTimers();
		try {
			const slow = new Promise<number>((r) => setTimeout(() => r(1), 200));
			const p = withTimeout(slow, 10);
			const outcome = expect(p).rejects.toThrow(TimeoutError);
			await vi.advanceTimersByTimeAsync(20);
			await outcome;
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects when timeoutMs is 0 (next-tick timeout)", async () => {
		const neverResolves = new Promise<number>(() => {});
		const p = withTimeout(neverResolves, 0);
		await expect(p).rejects.toThrow(TimeoutError);
	});
});
