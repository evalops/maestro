import { describe, expect, it, vi } from "vitest";
import { batchExecute } from "../../src/utils/async.js";

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
});
