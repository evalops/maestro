import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ConcurrencyManager,
	createConcurrencyManagerFromEnv,
} from "../../src/utils/concurrency-manager.js";
import { ConcurrencySlots } from "../../src/utils/concurrency-slots.js";

describe("ConcurrencyManager", () => {
	describe("constructor and basic state", () => {
		it("creates with specified max slots", () => {
			const slots = new ConcurrencyManager(3);
			const snapshot = slots.getSnapshot();
			expect(snapshot.max).toBe(3);
			expect(snapshot.active).toBe(0);
			expect(snapshot.queued).toBe(0);
		});

		it("creates with zero max slots (unlimited)", () => {
			const slots = new ConcurrencyManager(0);
			expect(slots.isEnabled()).toBe(false);
		});

		it("creates with negative max slots (unlimited)", () => {
			const slots = new ConcurrencyManager(-1);
			expect(slots.isEnabled()).toBe(false);
		});
	});

	describe("isEnabled", () => {
		it("returns true for positive max slots", () => {
			expect(new ConcurrencyManager(1).isEnabled()).toBe(true);
			expect(new ConcurrencyManager(5).isEnabled()).toBe(true);
		});

		it("returns false for zero or negative max slots", () => {
			expect(new ConcurrencyManager(0).isEnabled()).toBe(false);
			expect(new ConcurrencyManager(-1).isEnabled()).toBe(false);
		});
	});

	describe("acquire and release", () => {
		it("acquires slot immediately when available", async () => {
			const slots = new ConcurrencyManager(2);
			await slots.acquire();
			expect(slots.getSnapshot().active).toBe(1);
		});

		it("releases slot correctly", async () => {
			const slots = new ConcurrencyManager(2);
			await slots.acquire();
			slots.release();
			expect(slots.getSnapshot().active).toBe(0);
		});

		it("handles multiple acquire/release cycles", async () => {
			const slots = new ConcurrencyManager(2);
			await slots.acquire();
			await slots.acquire();
			expect(slots.getSnapshot().active).toBe(2);
			slots.release();
			expect(slots.getSnapshot().active).toBe(1);
			slots.release();
			expect(slots.getSnapshot().active).toBe(0);
		});

		it("does not go below zero on extra release", async () => {
			const slots = new ConcurrencyManager(2);
			await slots.acquire();
			slots.release();
			slots.release();
			slots.release();
			expect(slots.getSnapshot().active).toBe(0);
		});
	});

	describe("unlimited mode (maxSlots <= 0)", () => {
		it("acquire returns immediately with no limit", async () => {
			const slots = new ConcurrencyManager(0);
			await slots.acquire();
			await slots.acquire();
			await slots.acquire();
			// No tracking in unlimited mode
			expect(slots.getSnapshot().active).toBe(0);
		});

		it("release is safe in unlimited mode", async () => {
			const slots = new ConcurrencyManager(0);
			slots.release();
			slots.release();
			expect(slots.getSnapshot().active).toBe(0);
		});
	});

	describe("waiting and queuing", () => {
		it("queues when at capacity", async () => {
			const slots = new ConcurrencyManager(1);
			await slots.acquire();

			// Start a second acquire (will queue)
			let secondAcquired = false;
			const secondPromise = slots.acquire().then(() => {
				secondAcquired = true;
			});

			// Should be queued, not acquired
			await new Promise((r) => setTimeout(r, 10));
			expect(secondAcquired).toBe(false);
			expect(slots.getSnapshot().queued).toBe(1);

			// Release first slot
			slots.release();

			// Second should now acquire
			await secondPromise;
			expect(secondAcquired).toBe(true);
			expect(slots.getSnapshot().active).toBe(1);
		});

		it("maintains FIFO order", async () => {
			const slots = new ConcurrencyManager(1);
			await slots.acquire();

			const order: number[] = [];
			const p1 = slots.acquire().then(() => order.push(1));
			const p2 = slots.acquire().then(() => order.push(2));
			const p3 = slots.acquire().then(() => order.push(3));

			// Release all
			slots.release();
			await p1;
			slots.release();
			await p2;
			slots.release();
			await p3;

			expect(order).toEqual([1, 2, 3]);
		});
	});

	describe("withSlot", () => {
		it("acquires and releases around function", async () => {
			const slots = new ConcurrencyManager(2);
			let innerActive = 0;

			await slots.withSlot(async () => {
				innerActive = slots.getSnapshot().active;
			});

			expect(innerActive).toBe(1);
			expect(slots.getSnapshot().active).toBe(0);
		});

		it("returns function result", async () => {
			const slots = new ConcurrencyManager(2);
			const result = await slots.withSlot(async () => 42);
			expect(result).toBe(42);
		});

		it("releases slot even on error", async () => {
			const slots = new ConcurrencyManager(2);

			await expect(
				slots.withSlot(async () => {
					throw new Error("test error");
				}),
			).rejects.toThrow("test error");

			expect(slots.getSnapshot().active).toBe(0);
		});

		it("works with concurrent operations", async () => {
			const slots = new ConcurrencyManager(2);
			let maxConcurrent = 0;
			let current = 0;

			const work = async () => {
				current += 1;
				maxConcurrent = Math.max(maxConcurrent, current);
				await new Promise((r) => setTimeout(r, 10));
				current -= 1;
			};

			await Promise.all([
				slots.withSlot(work),
				slots.withSlot(work),
				slots.withSlot(work),
				slots.withSlot(work),
			]);

			expect(maxConcurrent).toBe(2);
			expect(slots.getSnapshot().active).toBe(0);
		});
	});

	describe("reset", () => {
		it("clears active slots", async () => {
			const slots = new ConcurrencyManager(2);
			await slots.acquire();
			await slots.acquire();
			slots.reset();
			expect(slots.getSnapshot().active).toBe(0);
		});

		it("resolves pending waiters", async () => {
			const slots = new ConcurrencyManager(1);
			await slots.acquire();

			let waiterResolved = false;
			const waiterPromise = slots.acquire().then(() => {
				waiterResolved = true;
			});

			slots.reset();
			await waiterPromise;
			expect(waiterResolved).toBe(true);
			expect(slots.getSnapshot().queued).toBe(0);
		});
	});
});

describe("createConcurrencyManagerFromEnv", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it("reads limit from environment variable", () => {
		process.env.TEST_CONCURRENCY = "5";
		const slots = createConcurrencyManagerFromEnv("TEST_CONCURRENCY");
		expect(slots.getSnapshot().max).toBe(5);
	});

	it("uses fallback when env var not set", () => {
		// biome-ignore lint/performance/noDelete: Must use delete, not = undefined
		delete process.env.TEST_CONCURRENCY;
		const slots = createConcurrencyManagerFromEnv("TEST_CONCURRENCY", 3);
		expect(slots.getSnapshot().max).toBe(3);
	});

	it("uses fallback when env var is empty string", () => {
		process.env.TEST_CONCURRENCY = "";
		const slots = createConcurrencyManagerFromEnv("TEST_CONCURRENCY", 3);
		expect(slots.getSnapshot().max).toBe(3);
	});

	it("uses fallback when env var is not a number", () => {
		process.env.TEST_CONCURRENCY = "not-a-number";
		const slots = createConcurrencyManagerFromEnv("TEST_CONCURRENCY", 3);
		expect(slots.getSnapshot().max).toBe(3);
	});

	it("uses default fallback of 0 (unlimited)", () => {
		// biome-ignore lint/performance/noDelete: Must use delete, not = undefined
		delete process.env.TEST_CONCURRENCY;
		const slots = createConcurrencyManagerFromEnv("TEST_CONCURRENCY");
		expect(slots.getSnapshot().max).toBe(0);
		expect(slots.isEnabled()).toBe(false);
	});

	it("parses zero correctly", () => {
		process.env.TEST_CONCURRENCY = "0";
		const slots = createConcurrencyManagerFromEnv("TEST_CONCURRENCY", 5);
		expect(slots.getSnapshot().max).toBe(0);
	});

	it("parses negative numbers", () => {
		process.env.TEST_CONCURRENCY = "-1";
		const slots = createConcurrencyManagerFromEnv("TEST_CONCURRENCY", 5);
		expect(slots.getSnapshot().max).toBe(-1);
		expect(slots.isEnabled()).toBe(false);
	});
});

describe("concurrency-slots compatibility shim", () => {
	it("exports ConcurrencySlots alias", () => {
		expect(ConcurrencySlots).toBe(ConcurrencyManager);
	});
});
