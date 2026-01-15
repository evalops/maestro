/**
 * Edit Serializer Tests
 *
 * Tests the file locking mechanism that prevents race conditions
 * when multiple edits are made to the same file in parallel.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditSerializer, batchEdits } from "../../src/tools/edit-serializer.js";

// We need to mock the logger before importing the module
vi.mock("../../src/utils/logger.js", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

describe("EditSerializer", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	describe("withLock", () => {
		it("executes function and returns result", async () => {
			const serializer = new EditSerializer({ cleanupIntervalMs: 60000 });
			serializer.stopCleanup();

			const result = await serializer.withLock("/test/file.ts", async () => {
				return "success";
			});

			expect(result).toBe("success");
		});

		it("acquires lock immediately when file is not locked", async () => {
			const serializer = new EditSerializer({ cleanupIntervalMs: 60000 });
			serializer.stopCleanup();

			const order: number[] = [];

			await serializer.withLock("/test/file.ts", async () => {
				order.push(1);
			});

			expect(order).toEqual([1]);
			expect(serializer.isLocked("/test/file.ts")).toBe(false);
		});

		it("serializes edits to the same file", async () => {
			const serializer = new EditSerializer({ cleanupIntervalMs: 60000 });
			serializer.stopCleanup();

			const order: number[] = [];
			let resolveFirst: () => void;
			const firstBlocked = new Promise<void>((r) => {
				resolveFirst = r;
			});

			// Start first edit - it will block
			const firstEdit = serializer.withLock("/test/file.ts", async () => {
				order.push(1);
				await firstBlocked;
				order.push(2);
				return "first";
			});

			// Let the first edit start
			await Promise.resolve();
			await Promise.resolve();

			// File should now be locked
			expect(serializer.isLocked("/test/file.ts")).toBe(true);

			// Start second edit - should queue
			const secondEdit = serializer.withLock("/test/file.ts", async () => {
				order.push(3);
				return "second";
			});

			// Queue length should be 1
			expect(serializer.getQueueLength("/test/file.ts")).toBe(1);

			// Release first edit
			resolveFirst!();
			await firstEdit;

			// Wait for second to complete
			await secondEdit;

			// Order should show serialization
			expect(order).toEqual([1, 2, 3]);
		});

		it("allows parallel edits to different files", async () => {
			const serializer = new EditSerializer({ cleanupIntervalMs: 60000 });
			serializer.stopCleanup();

			const started: string[] = [];
			const finished: string[] = [];
			let resolveA: () => void;
			let resolveB: () => void;
			const blockA = new Promise<void>((r) => {
				resolveA = r;
			});
			const blockB = new Promise<void>((r) => {
				resolveB = r;
			});

			// Start edit to file A
			const editA = serializer.withLock("/test/a.ts", async () => {
				started.push("A");
				await blockA;
				finished.push("A");
			});

			// Start edit to file B
			const editB = serializer.withLock("/test/b.ts", async () => {
				started.push("B");
				await blockB;
				finished.push("B");
			});

			// Let both start
			await Promise.resolve();
			await Promise.resolve();

			// Both should have started (parallel)
			expect(started).toContain("A");
			expect(started).toContain("B");

			// Release B first, then A
			resolveB!();
			await editB;
			expect(finished).toContain("B");

			resolveA!();
			await editA;
			expect(finished).toContain("A");
		});

		it("releases lock even when function throws", async () => {
			const serializer = new EditSerializer({ cleanupIntervalMs: 60000 });
			serializer.stopCleanup();

			await expect(
				serializer.withLock("/test/file.ts", async () => {
					throw new Error("test error");
				}),
			).rejects.toThrow("test error");

			// Lock should be released
			expect(serializer.isLocked("/test/file.ts")).toBe(false);

			// Should be able to acquire lock again
			const result = await serializer.withLock("/test/file.ts", async () => {
				return "recovered";
			});
			expect(result).toBe("recovered");
		});

		it("updates edit count after successful edit", async () => {
			const serializer = new EditSerializer({ cleanupIntervalMs: 60000 });
			serializer.stopCleanup();

			await serializer.withLock("/test/file.ts", async () => {});
			await serializer.withLock("/test/file.ts", async () => {});
			await serializer.withLock("/test/file.ts", async () => {});

			const stats = serializer.getStats();
			expect(stats.totalEdits).toBe(3);
		});
	});

	describe("queue management", () => {
		it("rejects when queue is full", async () => {
			const serializer = new EditSerializer({
				maxQueueLength: 2,
				cleanupIntervalMs: 60000,
			});
			serializer.stopCleanup();

			let resolveFirst: () => void;
			const blockFirst = new Promise<void>((r) => {
				resolveFirst = r;
			});

			// Hold the lock
			const first = serializer.withLock("/test/file.ts", async () => {
				await blockFirst;
			});

			await Promise.resolve();

			// Fill the queue
			const second = serializer.withLock("/test/file.ts", async () => {});
			const third = serializer.withLock("/test/file.ts", async () => {});

			await Promise.resolve();

			// This should fail - queue is full
			await expect(
				serializer.withLock("/test/file.ts", async () => {}),
			).rejects.toThrow("Edit queue full");

			// Clean up
			resolveFirst!();
			await first;
			await second;
			await third;
		});

		it("processes queue in order", async () => {
			const serializer = new EditSerializer({ cleanupIntervalMs: 60000 });
			serializer.stopCleanup();

			const order: number[] = [];
			let resolveFirst: () => void;
			const blockFirst = new Promise<void>((r) => {
				resolveFirst = r;
			});

			// First holds the lock
			const first = serializer.withLock("/test/file.ts", async () => {
				await blockFirst;
				order.push(1);
			});

			await Promise.resolve();

			// Queue up more
			const second = serializer.withLock("/test/file.ts", async () => {
				order.push(2);
			});
			const third = serializer.withLock("/test/file.ts", async () => {
				order.push(3);
			});

			// Release first
			resolveFirst!();

			await Promise.all([first, second, third]);

			expect(order).toEqual([1, 2, 3]);
		});
	});

	describe("timeout handling", () => {
		it("times out when lock is held too long", async () => {
			const serializer = new EditSerializer({
				lockTimeoutMs: 100,
				cleanupIntervalMs: 60000,
			});
			serializer.stopCleanup();

			let neverResolve: () => void;
			const blockForever = new Promise<void>((r) => {
				neverResolve = r;
			});

			// Hold the lock indefinitely
			const holder = serializer.withLock("/test/file.ts", async () => {
				await blockForever;
			});

			await Promise.resolve();

			// Try to acquire - should timeout
			const waiter = serializer.withLock("/test/file.ts", async () => {
				return "never reached";
			});

			// Advance time past timeout
			vi.advanceTimersByTime(150);

			await expect(waiter).rejects.toThrow("Lock timeout");

			// Clean up - release the holder
			neverResolve!();
			await holder.catch(() => {}); // Ignore any errors
		});

		it("removes timed-out waiter from queue", async () => {
			const serializer = new EditSerializer({
				lockTimeoutMs: 100,
				cleanupIntervalMs: 60000,
			});
			serializer.stopCleanup();

			let neverResolve: () => void;
			const blockForever = new Promise<void>((r) => {
				neverResolve = r;
			});

			// Hold the lock
			const holder = serializer.withLock("/test/file.ts", async () => {
				await blockForever;
			});

			await Promise.resolve();

			// Add waiter
			const waiter = serializer.withLock("/test/file.ts", async () => {});

			await Promise.resolve();
			expect(serializer.getQueueLength("/test/file.ts")).toBe(1);

			// Timeout the waiter
			vi.advanceTimersByTime(150);

			await waiter.catch(() => {});

			// Queue should be empty
			expect(serializer.getQueueLength("/test/file.ts")).toBe(0);

			neverResolve!();
			await holder.catch(() => {});
		});
	});

	describe("forceReleaseAll", () => {
		it("rejects all waiting locks", async () => {
			const serializer = new EditSerializer({ cleanupIntervalMs: 60000 });
			serializer.stopCleanup();

			let neverResolve: () => void;
			const blockForever = new Promise<void>((r) => {
				neverResolve = r;
			});

			// Hold the lock
			const holder = serializer.withLock("/test/file.ts", async () => {
				await blockForever;
			});

			await Promise.resolve();

			// Add waiters
			const waiter1 = serializer.withLock("/test/file.ts", async () => {});
			const waiter2 = serializer.withLock("/test/file.ts", async () => {});

			await Promise.resolve();

			// Force release
			serializer.forceReleaseAll();

			// Waiters should be rejected
			await expect(waiter1).rejects.toThrow("Lock force released");
			await expect(waiter2).rejects.toThrow("Lock force released");

			// Lock should be released
			expect(serializer.isLocked("/test/file.ts")).toBe(false);

			neverResolve!();
			await holder.catch(() => {});
		});
	});

	describe("reset", () => {
		it("clears all locks and state", async () => {
			const serializer = new EditSerializer({ cleanupIntervalMs: 60000 });
			serializer.stopCleanup();

			// Create some state
			await serializer.withLock("/test/a.ts", async () => {});
			await serializer.withLock("/test/b.ts", async () => {});

			const statsBefore = serializer.getStats();
			expect(statsBefore.filesTracked).toBe(2);
			expect(statsBefore.totalEdits).toBe(2);

			// Reset
			serializer.reset();

			const statsAfter = serializer.getStats();
			expect(statsAfter.filesTracked).toBe(0);
			expect(statsAfter.totalEdits).toBe(0);
		});
	});

	describe("getStats", () => {
		it("returns accurate statistics", async () => {
			const serializer = new EditSerializer({ cleanupIntervalMs: 60000 });
			serializer.stopCleanup();

			// No stats initially
			let stats = serializer.getStats();
			expect(stats.activeLocks).toBe(0);
			expect(stats.totalEdits).toBe(0);
			expect(stats.filesTracked).toBe(0);
			expect(stats.lockedFiles).toEqual([]);

			// Do some edits
			await serializer.withLock("/test/a.ts", async () => {});
			await serializer.withLock("/test/a.ts", async () => {});
			await serializer.withLock("/test/b.ts", async () => {});

			stats = serializer.getStats();
			expect(stats.activeLocks).toBe(0); // All done
			expect(stats.totalEdits).toBe(3);
			expect(stats.filesTracked).toBe(2);
		});

		it("tracks currently locked files", async () => {
			const serializer = new EditSerializer({ cleanupIntervalMs: 60000 });
			serializer.stopCleanup();

			let resolveA: () => void;
			const blockA = new Promise<void>((r) => {
				resolveA = r;
			});

			// Lock file A
			const editA = serializer.withLock("/test/a.ts", async () => {
				await blockA;
			});

			await Promise.resolve();

			const stats = serializer.getStats();
			expect(stats.activeLocks).toBe(1);
			expect(stats.lockedFiles).toContain("/test/a.ts");

			resolveA!();
			await editA;
		});
	});

	describe("isLocked", () => {
		it("returns false for unknown file", () => {
			const serializer = new EditSerializer({ cleanupIntervalMs: 60000 });
			serializer.stopCleanup();

			expect(serializer.isLocked("/unknown/file.ts")).toBe(false);
		});

		it("returns true when file is locked", async () => {
			const serializer = new EditSerializer({ cleanupIntervalMs: 60000 });
			serializer.stopCleanup();

			let resolve: () => void;
			const block = new Promise<void>((r) => {
				resolve = r;
			});

			const edit = serializer.withLock("/test/file.ts", async () => {
				await block;
			});

			await Promise.resolve();

			expect(serializer.isLocked("/test/file.ts")).toBe(true);

			resolve!();
			await edit;

			expect(serializer.isLocked("/test/file.ts")).toBe(false);
		});
	});

	describe("getQueueLength", () => {
		it("returns 0 for unknown file", () => {
			const serializer = new EditSerializer({ cleanupIntervalMs: 60000 });
			serializer.stopCleanup();

			expect(serializer.getQueueLength("/unknown/file.ts")).toBe(0);
		});

		it("tracks queue accurately", async () => {
			const serializer = new EditSerializer({ cleanupIntervalMs: 60000 });
			serializer.stopCleanup();

			let resolve: () => void;
			const block = new Promise<void>((r) => {
				resolve = r;
			});

			// Hold the lock
			const first = serializer.withLock("/test/file.ts", async () => {
				await block;
			});

			await Promise.resolve();

			expect(serializer.getQueueLength("/test/file.ts")).toBe(0);

			// Add to queue
			const second = serializer.withLock("/test/file.ts", async () => {});
			await Promise.resolve();
			expect(serializer.getQueueLength("/test/file.ts")).toBe(1);

			const third = serializer.withLock("/test/file.ts", async () => {});
			await Promise.resolve();
			expect(serializer.getQueueLength("/test/file.ts")).toBe(2);

			// Release
			resolve!();
			await Promise.all([first, second, third]);

			expect(serializer.getQueueLength("/test/file.ts")).toBe(0);
		});
	});

	describe("stale lock cleanup", () => {
		it("removes stale locks after 5 minutes of inactivity", async () => {
			const serializer = new EditSerializer({ cleanupIntervalMs: 1000 });

			// Create a lock entry
			await serializer.withLock("/test/file.ts", async () => {});

			expect(serializer.getStats().filesTracked).toBe(1);

			// Advance time past stale threshold (5 minutes)
			vi.advanceTimersByTime(5 * 60 * 1000 + 1000);

			// Wait for cleanup interval
			vi.advanceTimersByTime(1000);

			// Should be cleaned up
			expect(serializer.getStats().filesTracked).toBe(0);

			serializer.stopCleanup();
		});

		it("does not remove recently used locks", async () => {
			const serializer = new EditSerializer({ cleanupIntervalMs: 1000 });

			// Create a lock entry
			await serializer.withLock("/test/file.ts", async () => {});

			expect(serializer.getStats().filesTracked).toBe(1);

			// Advance time but not past threshold
			vi.advanceTimersByTime(60 * 1000);

			// Wait for cleanup interval
			vi.advanceTimersByTime(1000);

			// Should still be tracked
			expect(serializer.getStats().filesTracked).toBe(1);

			serializer.stopCleanup();
		});

		it("does not remove locked files during cleanup", async () => {
			const serializer = new EditSerializer({ cleanupIntervalMs: 1000 });

			let resolve: () => void;
			const block = new Promise<void>((r) => {
				resolve = r;
			});

			// Hold a lock
			const edit = serializer.withLock("/test/file.ts", async () => {
				await block;
			});

			await Promise.resolve();

			// Advance time past stale threshold
			vi.advanceTimersByTime(5 * 60 * 1000 + 1000);

			// Wait for cleanup
			vi.advanceTimersByTime(1000);

			// Should still be tracked (it's locked)
			expect(serializer.getStats().filesTracked).toBe(1);
			expect(serializer.isLocked("/test/file.ts")).toBe(true);

			resolve!();
			await edit;
			serializer.stopCleanup();
		});
	});

	describe("batchEdits", () => {
		it("executes all edits in sequence under one lock", async () => {
			const order: number[] = [];

			const results = await batchEdits("/test/file.ts", [
				async () => {
					order.push(1);
					return "a";
				},
				async () => {
					order.push(2);
					return "b";
				},
				async () => {
					order.push(3);
					return "c";
				},
			]);

			expect(order).toEqual([1, 2, 3]);
			expect(results).toEqual(["a", "b", "c"]);
		});

		it("handles empty edit array", async () => {
			const results = await batchEdits("/test/file.ts", []);
			expect(results).toEqual([]);
		});

		it("propagates errors from edits", async () => {
			await expect(
				batchEdits("/test/file.ts", [
					async () => "ok",
					async () => {
						throw new Error("edit failed");
					},
					async () => "never reached",
				]),
			).rejects.toThrow("edit failed");
		});
	});
});
