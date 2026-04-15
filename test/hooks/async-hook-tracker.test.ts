import { describe, expect, it } from "vitest";
import { AsyncHookTracker } from "../../src/hooks/async-hook-tracker.js";

describe("AsyncHookTracker", () => {
	it("tracks async hook processes and counts them", () => {
		const tracker = new AsyncHookTracker({ now: () => 123, maxAgeMs: 1000 });

		tracker.track({
			processId: "p1",
			hookEvent: "PreToolUse",
			hookName: "hook-1",
			command: "hook-1",
		});

		expect(tracker.getCount()).toBe(1);
	});

	it("marks completed processes", () => {
		const tracker = new AsyncHookTracker({ now: () => 0, maxAgeMs: 1000 });

		tracker.track({
			processId: "p1",
			hookEvent: "PreToolUse",
			hookName: "hook-1",
			command: "hook-1",
		});

		expect(tracker.markCompleted("p1")).toBe(true);
		expect(tracker.markCompleted("p1")).toBe(false);
		expect(tracker.getCount()).toBe(0);
	});

	it("cleans up stale processes by age", () => {
		let now = 0;
		const tracker = new AsyncHookTracker({ now: () => now, maxAgeMs: 10 });

		tracker.track({
			processId: "p1",
			hookEvent: "PreToolUse",
			hookName: "hook-1",
			command: "hook-1",
		});

		now = 5;
		expect(tracker.cleanup()).toEqual({
			removed: 0,
			remaining: 1,
			maxAgeMs: 10,
		});

		now = 25;
		expect(tracker.cleanup()).toEqual({
			removed: 1,
			remaining: 0,
			maxAgeMs: 10,
		});
	});
});
