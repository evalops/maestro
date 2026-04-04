import { afterEach, describe, expect, it, vi } from "vitest";
import { systemClock } from "../../src/utils/clock.js";

describe("systemClock", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("now() returns a number", () => {
		const t = systemClock.now();
		expect(typeof t).toBe("number");
		expect(t).toBeGreaterThan(0);
	});

	it("setTimeout invokes handler after delay", async () => {
		vi.useFakeTimers();
		let fired = false;
		const id = systemClock.setTimeout(() => {
			fired = true;
		}, 10);
		await vi.advanceTimersByTimeAsync(20);
		expect(fired).toBe(true);
		systemClock.clearTimeout(id);
	});

	it("clearTimeout cancels the timer", async () => {
		vi.useFakeTimers();
		let fired = false;
		const id = systemClock.setTimeout(() => {
			fired = true;
		}, 50);
		systemClock.clearTimeout(id);
		await vi.advanceTimersByTimeAsync(60);
		expect(fired).toBe(false);
	});
});
