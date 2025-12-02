import { describe, expect, it } from "vitest";
import {
	type AuditEntryData,
	computeEntryHash,
} from "../../src/audit/integrity.js";

describe("Audit Log Integrity", () => {
	describe("computeEntryHash", () => {
		const baseEntry: AuditEntryData = {
			id: "entry-1",
			orgId: "org-1",
			userId: "user-1",
			action: "test.action",
			timestamp: new Date("2024-01-01T00:00:00Z"),
			status: "success",
		};
		const genesisHash = "0".repeat(64);

		it("should produce consistent hash for same entry", () => {
			const hash1 = computeEntryHash(baseEntry, genesisHash);
			const hash2 = computeEntryHash(baseEntry, genesisHash);

			expect(hash1).toBe(hash2);
			expect(hash1).toHaveLength(64); // SHA-256 hex
			expect(hash1).toMatch(/^[a-f0-9]+$/);
		});

		it("should produce different hash for different entry IDs", () => {
			const entry1 = { ...baseEntry, id: "entry-1" };
			const entry2 = { ...baseEntry, id: "entry-2" };

			expect(computeEntryHash(entry1, genesisHash)).not.toBe(
				computeEntryHash(entry2, genesisHash),
			);
		});

		it("should produce different hash for different actions", () => {
			const entry1 = { ...baseEntry, action: "action.a" };
			const entry2 = { ...baseEntry, action: "action.b" };

			expect(computeEntryHash(entry1, genesisHash)).not.toBe(
				computeEntryHash(entry2, genesisHash),
			);
		});

		it("should produce different hash for different timestamps", () => {
			const entry1 = {
				...baseEntry,
				timestamp: new Date("2024-01-01T00:00:00Z"),
			};
			const entry2 = {
				...baseEntry,
				timestamp: new Date("2024-01-01T00:00:01Z"),
			};

			expect(computeEntryHash(entry1, genesisHash)).not.toBe(
				computeEntryHash(entry2, genesisHash),
			);
		});

		it("should produce different hash for different previous hashes", () => {
			const hash1 = computeEntryHash(baseEntry, "a".repeat(64));
			const hash2 = computeEntryHash(baseEntry, "b".repeat(64));

			expect(hash1).not.toBe(hash2);
		});

		it("should include metadata in hash", () => {
			const entry1 = { ...baseEntry, metadata: { foo: "bar" } };
			const entry2 = { ...baseEntry, metadata: { foo: "baz" } };

			expect(computeEntryHash(entry1, genesisHash)).not.toBe(
				computeEntryHash(entry2, genesisHash),
			);
		});

		it("should handle undefined optional fields", () => {
			const entry1 = { ...baseEntry };
			const entry2 = {
				...baseEntry,
				resourceType: "session",
				resourceId: "sess-1",
			};

			// Should not throw and should produce different hashes
			const hash1 = computeEntryHash(entry1, genesisHash);
			const hash2 = computeEntryHash(entry2, genesisHash);

			expect(hash1).toHaveLength(64);
			expect(hash2).toHaveLength(64);
			expect(hash1).not.toBe(hash2);
		});
	});

	describe("hash chain verification", () => {
		const genesisHash = "0".repeat(64);

		it("should create verifiable chain", () => {
			const entries: AuditEntryData[] = [
				{
					id: "1",
					orgId: "org-1",
					userId: "user-1",
					action: "action.a",
					timestamp: new Date("2024-01-01T00:00:00Z"),
					status: "success",
				},
				{
					id: "2",
					orgId: "org-1",
					userId: "user-1",
					action: "action.b",
					timestamp: new Date("2024-01-01T00:00:01Z"),
					status: "success",
				},
				{
					id: "3",
					orgId: "org-1",
					userId: "user-1",
					action: "action.c",
					timestamp: new Date("2024-01-01T00:00:02Z"),
					status: "success",
				},
			];

			// Build chain
			let previousHash = genesisHash;
			const hashes: string[] = [];

			for (const entry of entries) {
				const hash = computeEntryHash(entry, previousHash);
				hashes.push(hash);
				previousHash = hash;
			}

			// Verify chain
			previousHash = genesisHash;
			for (let i = 0; i < entries.length; i++) {
				const expectedHash = computeEntryHash(entries[i], previousHash);
				expect(expectedHash).toBe(hashes[i]);
				previousHash = hashes[i];
			}
		});

		it("should detect tampered entry in chain", () => {
			const entries: AuditEntryData[] = [
				{
					id: "1",
					orgId: "org-1",
					userId: "user-1",
					action: "action.a",
					timestamp: new Date("2024-01-01T00:00:00Z"),
					status: "success",
				},
				{
					id: "2",
					orgId: "org-1",
					userId: "user-1",
					action: "action.b",
					timestamp: new Date("2024-01-01T00:00:01Z"),
					status: "success",
				},
			];

			// Build chain with original data
			const hash1 = computeEntryHash(entries[0], genesisHash);
			const hash2 = computeEntryHash(entries[1], hash1);

			// Tamper with second entry
			const tamperedEntry = { ...entries[1], action: "action.TAMPERED" };
			const tamperedHash = computeEntryHash(tamperedEntry, hash1);

			// Hashes should not match
			expect(tamperedHash).not.toBe(hash2);
		});

		it("should detect inserted entry in chain", () => {
			const entry1: AuditEntryData = {
				id: "1",
				orgId: "org-1",
				userId: "user-1",
				action: "action.a",
				timestamp: new Date("2024-01-01T00:00:00Z"),
				status: "success",
			};
			const entry2: AuditEntryData = {
				id: "2",
				orgId: "org-1",
				userId: "user-1",
				action: "action.b",
				timestamp: new Date("2024-01-01T00:00:02Z"),
				status: "success",
			};

			// Original chain: entry1 -> entry2
			const hash1 = computeEntryHash(entry1, genesisHash);
			const hash2 = computeEntryHash(entry2, hash1);

			// Try to insert entry between them
			const inserted: AuditEntryData = {
				id: "inserted",
				orgId: "org-1",
				userId: "user-1",
				action: "action.inserted",
				timestamp: new Date("2024-01-01T00:00:01Z"),
				status: "success",
			};

			// If someone inserts, entry2's previous hash won't match
			const insertedHash = computeEntryHash(inserted, hash1);
			const newHash2 = computeEntryHash(entry2, insertedHash);

			// The new hash2 won't match original hash2
			expect(newHash2).not.toBe(hash2);
		});
	});
});
