import { describe, expect, it, vi } from "vitest";
import { RequestScheduler } from "./request-scheduler.js";

describe("RequestScheduler", () => {
	it("serializes requests when enabled", async () => {
		const scheduler = new RequestScheduler({
			serialize: true,
			minMutationDelayMs: 0,
		});
		const order: string[] = [];

		const first = scheduler.schedule(
			async () => {
				order.push("first");
			},
			{ mutating: false },
		);
		const second = scheduler.schedule(
			async () => {
				order.push("second");
			},
			{ mutating: false },
		);

		await Promise.all([first, second]);
		expect(order).toEqual(["first", "second"]);
	});

	it("enforces minimum delay between mutating requests", async () => {
		vi.useFakeTimers();
		const scheduler = new RequestScheduler({
			serialize: true,
			minMutationDelayMs: 1000,
		});
		const startTimes: number[] = [];

		const first = scheduler.schedule(
			async () => {
				startTimes.push(Date.now());
			},
			{ mutating: true },
		);
		const second = scheduler.schedule(
			async () => {
				startTimes.push(Date.now());
			},
			{ mutating: true },
		);

		await vi.runAllTimersAsync();
		await Promise.all([first, second]);
		expect(startTimes.length).toBe(2);
		expect(startTimes[1] - startTimes[0]).toBeGreaterThanOrEqual(1000);
		vi.useRealTimers();
	});
});
