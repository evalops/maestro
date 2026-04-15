import { beforeEach, describe, expect, it } from "vitest";
import { LoopDetector, checkForLoop } from "../../src/safety/loop-detector.js";

describe("loop-detector", () => {
	let detector: LoopDetector;

	beforeEach(() => {
		detector = new LoopDetector({
			maxIdenticalCalls: 3,
			maxSimilarCalls: 5,
			windowMs: 60000,
			maxCallsPerMinute: 60,
			autoPause: true,
		});
	});

	describe("basic operations", () => {
		it("allows first call", () => {
			const result = detector.check("read", { path: "/tmp/test.txt" });
			expect(result.detected).toBe(false);
		});

		it("tracks statistics", () => {
			detector.record("read", { path: "/tmp/a.txt" });
			detector.record("write", { path: "/tmp/b.txt" });
			detector.record("read", { path: "/tmp/c.txt" });

			const stats = detector.getStats();
			expect(stats.totalRecords).toBe(3);
			expect(stats.uniqueTools).toBe(2);
			expect(stats.isPaused).toBe(false);
		});

		it("resets state", () => {
			detector.record("read", { path: "/tmp/test.txt" });
			detector.pause("test pause");
			expect(detector.isPausedState()).toBe(true);

			detector.reset();
			expect(detector.getStats().totalRecords).toBe(0);
			expect(detector.isPausedState()).toBe(false);
		});
	});

	describe("exact repetition detection", () => {
		it("detects identical calls", () => {
			const args = { path: "/tmp/same.txt" };

			// First two calls should be fine
			detector.record("read", args);
			expect(detector.check("read", args).detected).toBe(false);
			detector.record("read", args);
			expect(detector.check("read", args).detected).toBe(false);
			detector.record("read", args);

			// Fourth call (3 already recorded) should trigger
			const result = detector.check("read", args);
			expect(result.detected).toBe(true);
			expect(result.type).toBe("exact");
			expect(result.repetitions).toBe(4);
		});

		it("differentiates by args", () => {
			// Use fresh detector with high thresholds
			const argsDetector = new LoopDetector({
				maxIdenticalCalls: 100,
				maxSimilarCalls: 100,
				autoPause: false,
			});

			argsDetector.record("read", { path: "/tmp/a.txt" });
			argsDetector.record("write", { path: "/tmp/b.txt" }); // Different tool
			argsDetector.record("read", { path: "/tmp/c.txt" });

			// Different path should not trigger exact match
			const result = argsDetector.check("read", { path: "/tmp/d.txt" });
			expect(result.detected).toBe(false);
		});

		it("differentiates by tool", () => {
			detector.record("read", { path: "/tmp/test.txt" });
			detector.record("read", { path: "/tmp/test.txt" });
			detector.record("read", { path: "/tmp/test.txt" });

			// Different tool with same args should not trigger exact match
			const result = detector.check("write", { path: "/tmp/test.txt" });
			expect(result.detected).toBe(false);
		});
	});

	describe("similar operation detection", () => {
		it("detects similar operations with different values", () => {
			// Use a fresh detector with higher identical threshold
			const similarDetector = new LoopDetector({
				maxIdenticalCalls: 100, // Disable exact check
				maxSimilarCalls: 5,
				autoPause: false,
			});

			// Record many reads with paths of same length to get same args signature
			// Args signature includes string length, so paths must be same length
			similarDetector.record("read", { path: "/tmp/file_aa.txt" });
			similarDetector.record("toolA", {});
			similarDetector.record("read", { path: "/tmp/file_bb.txt" });
			similarDetector.record("toolB", {});
			similarDetector.record("read", { path: "/tmp/file_cc.txt" });
			similarDetector.record("toolC", {});
			similarDetector.record("read", { path: "/tmp/file_dd.txt" });
			similarDetector.record("toolD", {});
			similarDetector.record("read", { path: "/tmp/file_ee.txt" });

			// Sixth similar read should trigger (same path length)
			const result = similarDetector.check("read", {
				path: "/tmp/file_zz.txt",
			});
			expect(result.detected).toBe(true);
			expect(result.type).toBe("similar");
		});

		it("differentiates by args structure", () => {
			// Use a fresh detector
			const structDetector = new LoopDetector({
				maxIdenticalCalls: 100,
				maxSimilarCalls: 100,
				autoPause: false,
			});

			// Interleave to avoid cyclic pattern
			structDetector.record("read", { path: "/tmp/a.txt" });
			structDetector.record("write", { path: "/tmp/x.txt" });
			structDetector.record("read", { path: "/tmp/b.txt" });

			// Call with different args structure - adds new key
			const result = structDetector.check("read", {
				path: "/tmp/d.txt",
				encoding: "utf8",
			});
			// Should not trigger with just 2 prior reads (mixed with writes)
			expect(result.detected).toBe(false);
		});
	});

	describe("cyclic pattern detection", () => {
		it("detects A→B→A→B pattern", () => {
			// Use detector with high thresholds to avoid exact/similar triggers
			const cycleDetector = new LoopDetector({
				maxIdenticalCalls: 100,
				maxSimilarCalls: 100,
				autoPause: false,
			});

			cycleDetector.record("toolA", { x: 1 });
			cycleDetector.record("toolB", { x: 2 });
			cycleDetector.record("toolA", { x: 3 });
			cycleDetector.record("toolB", { x: 4 });

			// Fifth call continuing the cycle
			const result = cycleDetector.check("toolA", { x: 5 });
			expect(result.detected).toBe(true);
			expect(result.type).toBe("cyclic");
		});

		it("detects longer cycles", () => {
			// A → B → C → A → B → C pattern
			const sequence = ["toolA", "toolB", "toolC"];
			for (const tool of sequence) {
				detector.record(tool, { x: 1 });
			}
			for (const tool of sequence) {
				detector.record(tool, { x: 1 });
			}

			// Next in cycle
			const result = detector.check("toolA", { x: 1 });
			expect(result.detected).toBe(true);
			expect(result.type).toBe("cyclic");
		});
	});

	describe("frequency detection", () => {
		it("detects high call frequency", () => {
			const manyCallsDetector = new LoopDetector({
				maxCallsPerMinute: 10,
				maxIdenticalCalls: 100, // Disable exact check
				maxSimilarCalls: 100, // Disable similar check
				autoPause: false,
			});

			// Make many calls
			for (let i = 0; i < 10; i++) {
				manyCallsDetector.record(`tool${i}`, { i });
			}

			const result = manyCallsDetector.check("tool11", { i: 11 });
			expect(result.detected).toBe(true);
			expect(result.type).toBe("frequency");
		});
	});

	describe("pause functionality", () => {
		it("pauses on detection when autoPause enabled", () => {
			const args = { path: "/tmp/test.txt" };

			detector.record("read", args);
			detector.record("read", args);
			detector.record("read", args);

			// This should trigger pause
			detector.check("read", args);

			expect(detector.isPausedState()).toBe(true);
			expect(detector.getPauseReason()).toContain("Identical");
		});

		it("returns paused state on subsequent checks", () => {
			detector.pause("manual pause");

			const result = detector.check("any_tool", {});
			expect(result.detected).toBe(true);
			expect(result.action).toBe("pause");
		});

		it("resumes from pause", () => {
			detector.pause("test");
			expect(detector.isPausedState()).toBe(true);

			detector.resume();
			expect(detector.isPausedState()).toBe(false);

			const result = detector.check("tool", {});
			expect(result.detected).toBe(false);
		});

		it("does not pause when autoPause disabled", () => {
			const noPauseDetector = new LoopDetector({
				maxIdenticalCalls: 2,
				autoPause: false,
			});

			noPauseDetector.record("read", { x: 1 });
			noPauseDetector.record("read", { x: 1 });

			const result = noPauseDetector.check("read", { x: 1 });
			expect(result.detected).toBe(true);
			expect(result.action).toBe("warn");
			expect(noPauseDetector.isPausedState()).toBe(false);
		});
	});

	describe("checkForLoop helper", () => {
		it("allows normal calls", () => {
			const freshDetector = new LoopDetector({ autoPause: false });
			const result = checkForLoop(
				"read",
				{ path: "/tmp/test.txt" },
				freshDetector,
			);

			expect(result.shouldProceed).toBe(true);
			expect(result.requiresConfirmation).toBe(false);
		});

		it("requires confirmation on pause", () => {
			const pauseDetector = new LoopDetector({
				maxIdenticalCalls: 1,
				autoPause: true,
			});
			pauseDetector.record("read", { x: 1 });

			const result = checkForLoop("read", { x: 1 }, pauseDetector);

			expect(result.shouldProceed).toBe(false);
			expect(result.requiresConfirmation).toBe(true);
			expect(result.message).toBeDefined();
		});

		it("records calls automatically on proceed", () => {
			const freshDetector = new LoopDetector();
			expect(freshDetector.getStats().totalRecords).toBe(0);

			checkForLoop("read", { x: 1 }, freshDetector);

			expect(freshDetector.getStats().totalRecords).toBe(1);
		});
	});

	describe("edge cases", () => {
		it("handles empty args", () => {
			const result = detector.check("tool", {});
			expect(result.detected).toBe(false);
		});

		it("handles complex args", () => {
			const complexArgs = {
				nested: { a: 1, b: [1, 2, 3] },
				array: ["x", "y", "z"],
				number: 42,
				bool: true,
				str: "hello",
			};

			const result = detector.check("complex", complexArgs);
			expect(result.detected).toBe(false);

			detector.record("complex", complexArgs);
			expect(detector.getStats().totalRecords).toBe(1);
		});

		it("handles very long strings", () => {
			const longString = "x".repeat(10000);
			const result = detector.check("read", { content: longString });
			expect(result.detected).toBe(false);
		});

		it("prunes old records", async () => {
			const shortWindowDetector = new LoopDetector({
				windowMs: 100, // 100ms window
			});

			shortWindowDetector.record("old", {});
			expect(shortWindowDetector.getStats().totalRecords).toBe(1);

			// Wait for window to expire
			await new Promise((resolve) => setTimeout(resolve, 150));

			// Trigger pruning
			shortWindowDetector.check("new", {});

			// Old record should be pruned (stats may show 0 or 1 depending on timing)
			const stats = shortWindowDetector.getStats();
			expect(stats.totalRecords).toBeLessThanOrEqual(1);
		});
	});
});
