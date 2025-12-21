import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStorageBackend } from "../src/storage.js";

describe("FileStorageBackend", () => {
	let dir: string;
	let storage: FileStorageBackend;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "slack-agent-storage-"));
		storage = new FileStorageBackend(dir);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	describe("get/set", () => {
		it("stores and retrieves values", async () => {
			await storage.set("key1", { foo: "bar" });
			const result = await storage.get<{ foo: string }>("key1");
			expect(result).toEqual({ foo: "bar" });
		});

		it("returns null for non-existent keys", async () => {
			const result = await storage.get("nonexistent");
			expect(result).toBeNull();
		});

		it("handles special characters in keys", async () => {
			await storage.set("thread:C123:1234567890.123456", { data: "test" });
			const result = await storage.get<{ data: string }>(
				"thread:C123:1234567890.123456",
			);
			expect(result).toEqual({ data: "test" });
		});

		it("overwrites existing values", async () => {
			await storage.set("key", { version: 1 });
			await storage.set("key", { version: 2 });
			const result = await storage.get<{ version: number }>("key");
			expect(result).toEqual({ version: 2 });
		});
	});

	describe("setNX (atomic set-if-not-exists)", () => {
		it("sets value when key does not exist", async () => {
			const result = await storage.setNX("newkey", { value: 1 });
			expect(result).toBe(true);
			const stored = await storage.get<{ value: number }>("newkey");
			expect(stored).toEqual({ value: 1 });
		});

		it("treats expired keys as available", async () => {
			await storage.set("expiring", { value: 1 }, 1);
			await new Promise((r) => setTimeout(r, 10));

			const result = await storage.setNX("expiring", { value: 2 });
			expect(result).toBe(true);
			const stored = await storage.get<{ value: number }>("expiring");
			expect(stored).toEqual({ value: 2 });
		});

		it("returns false when key already exists", async () => {
			await storage.set("existing", { value: 1 });
			const result = await storage.setNX("existing", { value: 2 });
			expect(result).toBe(false);
			// Original value should be preserved
			const stored = await storage.get<{ value: number }>("existing");
			expect(stored).toEqual({ value: 1 });
		});

		it("is atomic - concurrent calls only one succeeds", async () => {
			const results = await Promise.all([
				storage.setNX("race", { winner: 1 }),
				storage.setNX("race", { winner: 2 }),
				storage.setNX("race", { winner: 3 }),
			]);
			// Exactly one should succeed
			const successCount = results.filter((r) => r).length;
			expect(successCount).toBe(1);
		});
	});

	describe("TTL expiration", () => {
		it("returns null for expired values", async () => {
			await storage.set("expiring", { data: "test" }, 1); // 1ms TTL
			await new Promise((r) => setTimeout(r, 10));
			const result = await storage.get("expiring");
			expect(result).toBeNull();
		});

		it("returns value before expiration", async () => {
			await storage.set("valid", { data: "test" }, 60000); // 1 minute TTL
			const result = await storage.get<{ data: string }>("valid");
			expect(result).toEqual({ data: "test" });
		});
	});

	describe("delete", () => {
		it("deletes existing key", async () => {
			await storage.set("todelete", { data: "test" });
			const deleted = await storage.delete("todelete");
			expect(deleted).toBe(true);
			const result = await storage.get("todelete");
			expect(result).toBeNull();
		});

		it("returns false for non-existent key", async () => {
			const deleted = await storage.delete("nonexistent");
			expect(deleted).toBe(false);
		});
	});

	describe("exists", () => {
		it("returns true for existing key", async () => {
			await storage.set("exists", { data: "test" });
			const result = await storage.exists("exists");
			expect(result).toBe(true);
		});

		it("returns false for expired key", async () => {
			await storage.set("expired", { data: "test" }, 1);
			await new Promise((r) => setTimeout(r, 10));
			const result = await storage.exists("expired");
			expect(result).toBe(false);
		});

		it("returns false for non-existent key", async () => {
			const result = await storage.exists("nonexistent");
			expect(result).toBe(false);
		});
	});

	describe("keys", () => {
		it("returns keys matching pattern", async () => {
			await storage.set("thread:C1:T1", { data: 1 });
			await storage.set("thread:C1:T2", { data: 2 });
			await storage.set("other:key", { data: 3 });

			const threadKeys = await storage.keys("thread:*");
			expect(threadKeys).toHaveLength(2);
			expect(threadKeys).toContain("thread:C1:T1");
			expect(threadKeys).toContain("thread:C1:T2");
		});

		it("omits expired keys", async () => {
			await storage.set("thread:C1:old", { data: 1 }, 1);
			await new Promise((r) => setTimeout(r, 10));
			await storage.set("thread:C1:new", { data: 2 });

			const keys = await storage.keys("thread:*");
			expect(keys).toContain("thread:C1:new");
			expect(keys).not.toContain("thread:C1:old");
		});

		it("returns empty array when no matches", async () => {
			await storage.set("key1", { data: 1 });
			const result = await storage.keys("nomatch:*");
			expect(result).toEqual([]);
		});

		it("uses stored key for accurate reconstruction", async () => {
			// Keys with both : and . should be correctly stored and retrieved
			await storage.set("thread:C123:1234.5678", { data: "test" });
			const keys = await storage.keys("thread:*");
			expect(keys).toContain("thread:C123:1234.5678");
		});
	});
});
