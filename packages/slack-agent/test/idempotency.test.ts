import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IdempotencyManager, withIdempotency } from "../src/idempotency.js";

describe("IdempotencyManager", () => {
	let dir: string;
	let manager: IdempotencyManager;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "slack-agent-idempotency-"));
		manager = new IdempotencyManager(dir, { ttlMs: 60000, lockTimeout: 5000 });
	});

	afterEach(async () => {
		await manager.shutdown();
		await rm(dir, { recursive: true, force: true });
	});

	describe("checkAndLock", () => {
		it("allows first event to be processed", async () => {
			const result = await manager.checkAndLock("event1", "message");
			expect(result.shouldProcess).toBe(true);
			expect(result.isDuplicate).toBe(false);
			expect(result.previousFailed).toBe(false);
		});

		it("blocks duplicate events", async () => {
			await manager.checkAndLock("event1", "message");
			await manager.markComplete("event1");

			const result = await manager.checkAndLock("event1", "message");
			expect(result.shouldProcess).toBe(false);
			expect(result.isDuplicate).toBe(true);
		});

		it("blocks events currently being processed", async () => {
			await manager.checkAndLock("event1", "message");
			// Don't mark complete - simulates in-progress

			const result = await manager.checkAndLock("event1", "message");
			expect(result.shouldProcess).toBe(false);
			expect(result.isDuplicate).toBe(true);
		});

		it("allows retry of failed events", async () => {
			await manager.checkAndLock("event1", "message");
			await manager.markFailed("event1", "Test error");

			const result = await manager.checkAndLock("event1", "message");
			expect(result.shouldProcess).toBe(true);
			expect(result.previousFailed).toBe(true);
			expect(result.previousError).toBe("Test error");
		});

		it("uses atomic locking to prevent race conditions", async () => {
			// Simulate concurrent requests for the same event
			const results = await Promise.all([
				manager.checkAndLock("race-event", "message"),
				manager.checkAndLock("race-event", "message"),
				manager.checkAndLock("race-event", "message"),
			]);

			// Exactly one should be allowed to process
			const processCount = results.filter((r) => r.shouldProcess).length;
			expect(processCount).toBe(1);
		});
	});

	describe("markComplete", () => {
		it("marks event as completed", async () => {
			await manager.checkAndLock("event1", "message");
			await manager.markComplete("event1");

			const result = await manager.checkAndLock("event1", "message");
			expect(result.shouldProcess).toBe(false);
			expect(result.isDuplicate).toBe(true);
		});
	});

	describe("markFailed", () => {
		it("marks event as failed with error", async () => {
			await manager.checkAndLock("event1", "message");
			await manager.markFailed("event1", "Connection timeout");

			const result = await manager.checkAndLock("event1", "message");
			expect(result.shouldProcess).toBe(true);
			expect(result.previousFailed).toBe(true);
			expect(result.previousError).toBe("Connection timeout");
		});
	});
});

describe("withIdempotency wrapper", () => {
	let dir: string;
	let manager: IdempotencyManager;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "slack-agent-idempotency-wrapper-"));
		manager = new IdempotencyManager(dir);
	});

	afterEach(async () => {
		await manager.shutdown();
		await rm(dir, { recursive: true, force: true });
	});

	it("processes event and marks complete on success", async () => {
		let processed = false;
		const handler = withIdempotency(
			manager,
			async () => {
				processed = true;
			},
			(e: { id: string }) => e.id,
		);

		const result = await handler({ id: "test-1" });
		expect(result.processed).toBe(true);
		expect(result.skipped).toBe(false);
		expect(processed).toBe(true);
	});

	it("skips duplicate events", async () => {
		let processCount = 0;
		const handler = withIdempotency(
			manager,
			async () => {
				processCount++;
			},
			(e: { id: string }) => e.id,
		);

		await handler({ id: "test-1" });
		const result = await handler({ id: "test-1" });

		expect(result.processed).toBe(false);
		expect(result.skipped).toBe(true);
		expect(processCount).toBe(1);
	});

	it("marks failed on error and allows retry", async () => {
		let attempt = 0;
		const handler = withIdempotency(
			manager,
			async () => {
				attempt++;
				if (attempt === 1) {
					throw new Error("First attempt fails");
				}
			},
			(e: { id: string }) => e.id,
		);

		const first = await handler({ id: "test-1" });
		expect(first.processed).toBe(false);
		expect(first.error).toBe("First attempt fails");

		const second = await handler({ id: "test-1" });
		expect(second.processed).toBe(true);
		expect(attempt).toBe(2);
	});
});

describe("IdempotencyManager with null workingDir", () => {
	it("uses in-memory storage when workingDir is null", async () => {
		const manager = new IdempotencyManager(null);

		const result1 = await manager.checkAndLock("event1", "message");
		expect(result1.shouldProcess).toBe(true);

		await manager.markComplete("event1");

		const result2 = await manager.checkAndLock("event1", "message");
		expect(result2.shouldProcess).toBe(false);
		expect(result2.isDuplicate).toBe(true);

		await manager.shutdown();
	});
});
