import { describe, expect, it } from "vitest";
import { systemClock } from "../../src/utils/clock.js";

describe("systemClock", () => {
	it("now() returns a number", () => {
		const t = systemClock.now();
		expect(typeof t).toBe("number");
		expect(t).toBeGreaterThan(0);
	});

	it("setTimeout invokes handler after delay", async () => {
		let fired = false;
		const id = systemClock.setTimeout(() => {
			fired = true;
		}, 10);
		await new Promise((r) => setTimeout(r, 20));
		expect(fired).toBe(true);
		systemClock.clearTimeout(id);
	});

	it("clearTimeout cancels the timer", async () => {
		let fired = false;
		const id = systemClock.setTimeout(() => {
			fired = true;
		}, 50);
		systemClock.clearTimeout(id);
		await new Promise((r) => setTimeout(r, 60));
		expect(fired).toBe(false);
	});
});
