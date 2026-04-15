import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Helper to create a v1 session entry (no id/parentId)
function createV1MessageEntry(role: "user" | "assistant", text: string) {
	return {
		type: "message",
		timestamp: new Date().toISOString(),
		message: {
			role,
			content: [{ type: "text", text }],
		},
	};
}

// Helper to create a v1 compaction entry with index
function createV1CompactionEntry(firstKeptEntryIndex: number) {
	return {
		type: "compaction",
		timestamp: new Date().toISOString(),
		summary: "Test compaction summary",
		firstKeptEntryIndex,
		tokensBefore: 1000,
	};
}

// Helper to create a v1 session header
function createV1SessionHeader(id: string) {
	return {
		type: "session",
		id,
		timestamp: new Date().toISOString(),
		cwd: "/test/dir",
		// Note: no version field = v1
	};
}

// Helper to create a v2 session header
function createV2SessionHeader(id: string) {
	return {
		type: "session",
		version: 2,
		id,
		timestamp: new Date().toISOString(),
		cwd: "/test/dir",
	};
}

// Helper to create a v2 message entry with id/parentId
function createV2MessageEntry(
	id: string,
	parentId: string | null,
	role: "user" | "assistant",
	text: string,
) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: {
			role,
			content: [{ type: "text", text }],
		},
	};
}

// Helper to write a session file
function writeSessionFile(dir: string, filename: string, entries: unknown[]) {
	const content = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
	const filePath = join(dir, filename);
	writeFileSync(filePath, content);
	return filePath;
}

// Helper to read session entries from file
function readSessionEntries(filePath: string) {
	const content = readFileSync(filePath, "utf8").trim();
	return content.split("\n").map((line) => JSON.parse(line));
}

describe("Session Migration", () => {
	let testDir: string;
	let sessionDir: string;
	let originalCwd: string;
	let originalEnv: string | undefined;

	// Dynamic module import - fresh for each test
	async function importMigrationModule() {
		vi.resetModules();
		return await import("../../src/session/migration.js");
	}

	beforeEach(() => {
		// Save original state
		originalCwd = process.cwd();
		originalEnv = process.env.MAESTRO_AGENT_DIR;

		// Create isolated test directory
		testDir = mkdtempSync(join(tmpdir(), "composer-migration-test-"));
		process.env.MAESTRO_AGENT_DIR = testDir;

		// Change to test directory so session path is computed correctly
		process.chdir(testDir);

		// Compute session directory the same way migration.ts does
		const cwd = process.cwd();
		const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		sessionDir = join(testDir, "sessions", safePath);
		mkdirSync(sessionDir, { recursive: true });
	});

	afterEach(() => {
		// Restore original state
		process.chdir(originalCwd);
		if (originalEnv === undefined) {
			delete process.env.MAESTRO_AGENT_DIR;
		} else {
			process.env.MAESTRO_AGENT_DIR = originalEnv;
		}

		// Cleanup test directory
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe("migrateV1ToV2 (via runSessionMigration)", () => {
		it("adds IDs to entries without them", async () => {
			const entries = [
				createV1SessionHeader("session-1"),
				createV1MessageEntry("user", "Hello"),
				createV1MessageEntry("assistant", "Hi there"),
			];
			const filePath = writeSessionFile(
				sessionDir,
				"test-session.jsonl",
				entries,
			);

			const { runSessionMigration } = await importMigrationModule();
			await runSessionMigration();

			const migrated = readSessionEntries(filePath);
			expect(migrated[1].id).toBeTruthy();
			expect(migrated[2].id).toBeTruthy();
			expect(migrated[1].id).not.toBe(migrated[2].id);
		});

		it("builds parentId chain correctly", async () => {
			const entries = [
				createV1SessionHeader("session-1"),
				createV1MessageEntry("user", "First"),
				createV1MessageEntry("assistant", "Second"),
				createV1MessageEntry("user", "Third"),
			];
			const filePath = writeSessionFile(
				sessionDir,
				"test-session.jsonl",
				entries,
			);

			const { runSessionMigration } = await importMigrationModule();
			await runSessionMigration();

			const migrated = readSessionEntries(filePath);
			expect(migrated[1].parentId).toBeNull();
			expect(migrated[2].parentId).toBe(migrated[1].id);
			expect(migrated[3].parentId).toBe(migrated[2].id);
		});

		it("updates version header to v2", async () => {
			const entries = [
				createV1SessionHeader("session-1"),
				createV1MessageEntry("user", "Hello"),
			];
			const filePath = writeSessionFile(
				sessionDir,
				"test-session.jsonl",
				entries,
			);

			const { runSessionMigration } = await importMigrationModule();
			await runSessionMigration();

			const migrated = readSessionEntries(filePath);
			expect(migrated[0].version).toBe(2);
		});

		it("converts firstKeptEntryIndex to firstKeptEntryId for compaction", async () => {
			const entries = [
				createV1SessionHeader("session-1"),
				createV1MessageEntry("user", "Message 0"),
				createV1MessageEntry("assistant", "Message 1"),
				createV1MessageEntry("user", "Message 2"),
				createV1CompactionEntry(1), // Points to "Message 1"
			];
			const filePath = writeSessionFile(
				sessionDir,
				"test-session.jsonl",
				entries,
			);

			const { runSessionMigration } = await importMigrationModule();
			await runSessionMigration();

			const migrated = readSessionEntries(filePath);
			const compaction = migrated[4];

			// Should have converted index to ID
			expect(compaction.firstKeptEntryId).toBe(migrated[2].id);
			expect(compaction.firstKeptEntryIndex).toBeUndefined();
		});

		it("handles compaction pointing to first entry (index 0)", async () => {
			const entries = [
				createV1SessionHeader("session-1"),
				createV1MessageEntry("user", "Only message"),
				createV1CompactionEntry(0),
			];
			const filePath = writeSessionFile(
				sessionDir,
				"test-session.jsonl",
				entries,
			);

			const { runSessionMigration } = await importMigrationModule();
			await runSessionMigration();

			const migrated = readSessionEntries(filePath);
			expect(migrated[2].firstKeptEntryId).toBe(migrated[1].id);
		});

		it("handles compaction with out-of-bounds index gracefully", async () => {
			const entries = [
				createV1SessionHeader("session-1"),
				createV1MessageEntry("user", "Only message"),
				createV1CompactionEntry(999), // Invalid index
			];
			const filePath = writeSessionFile(
				sessionDir,
				"test-session.jsonl",
				entries,
			);

			const { runSessionMigration } = await importMigrationModule();
			await runSessionMigration();

			const migrated = readSessionEntries(filePath);
			// Should fall back to first message or compaction's own ID
			expect(migrated[2].firstKeptEntryId).toBeTruthy();
		});

		it("regenerates duplicate IDs", async () => {
			const entries = [
				createV1SessionHeader("session-1"),
				{ ...createV1MessageEntry("user", "First"), id: "duplicate-id" },
				{ ...createV1MessageEntry("assistant", "Second"), id: "duplicate-id" },
			];
			const filePath = writeSessionFile(
				sessionDir,
				"test-session.jsonl",
				entries,
			);

			const { runSessionMigration } = await importMigrationModule();
			await runSessionMigration();

			const migrated = readSessionEntries(filePath);
			expect(migrated[1].id).not.toBe(migrated[2].id);
		});

		it("includes custom_message and branch_summary in message index for compaction", async () => {
			const entries = [
				createV1SessionHeader("session-1"),
				createV1MessageEntry("user", "Message 0"),
				{
					type: "custom_message",
					customType: "hook",
					content: "Custom content",
					display: true,
					timestamp: new Date().toISOString(),
				},
				{
					type: "branch_summary",
					fromId: "root",
					summary: "Branch summary",
					timestamp: new Date().toISOString(),
				},
				createV1CompactionEntry(2), // Points to branch_summary (index 2 in messageEntries)
			];
			const filePath = writeSessionFile(
				sessionDir,
				"test-session.jsonl",
				entries,
			);

			const { runSessionMigration } = await importMigrationModule();
			await runSessionMigration();

			const migrated = readSessionEntries(filePath);
			const compaction = migrated[4];
			// Index 2 should be branch_summary (index 3 in full entries array)
			expect(compaction.firstKeptEntryId).toBe(migrated[3].id);
		});
	});

	describe("runSessionMigration", () => {
		it("skips already-migrated v2 sessions", async () => {
			const entries = [
				createV2SessionHeader("session-1"),
				createV2MessageEntry("id1", null, "user", "Hello"),
				createV2MessageEntry("id2", "id1", "assistant", "Hi"),
			];
			const filePath = writeSessionFile(
				sessionDir,
				"test-session.jsonl",
				entries,
			);
			const originalContent = readFileSync(filePath, "utf8");

			const { runSessionMigration, getMigrationState } =
				await importMigrationModule();
			await runSessionMigration();

			// File should not be modified
			expect(readFileSync(filePath, "utf8")).toBe(originalContent);

			const state = getMigrationState();
			expect(state?.skipped).toBe(1);
			expect(state?.normalized).toBe(0);
		});

		it("skips active session files registered in skipFiles", async () => {
			const entries = [
				createV1SessionHeader("session-1"),
				createV1MessageEntry("user", "Hello"),
			];
			const filePath = writeSessionFile(
				sessionDir,
				"active-session.jsonl",
				entries,
			);
			const originalContent = readFileSync(filePath, "utf8");

			const {
				runSessionMigration,
				getMigrationState,
				registerActiveSessionFile,
				unregisterActiveSessionFile,
			} = await importMigrationModule();

			// Register as active
			registerActiveSessionFile(filePath);

			await runSessionMigration();

			// File should not be modified
			expect(readFileSync(filePath, "utf8")).toBe(originalContent);

			const state = getMigrationState();
			expect(state?.skipped).toBe(1);

			// Cleanup
			unregisterActiveSessionFile(filePath);
		});

		it("counts successes and failures correctly", async () => {
			// Create one valid v1 session
			writeSessionFile(sessionDir, "valid.jsonl", [
				createV1SessionHeader("session-1"),
				createV1MessageEntry("user", "Hello"),
			]);

			// Create one corrupt session
			writeFileSync(join(sessionDir, "corrupt.jsonl"), "not valid json\n");

			const { runSessionMigration, getMigrationState } =
				await importMigrationModule();
			await runSessionMigration();

			const state = getMigrationState();
			expect(state?.total).toBe(2);
			expect(state?.normalized).toBeGreaterThanOrEqual(1);
		});

		it("persists migration state to disk", async () => {
			writeSessionFile(sessionDir, "test.jsonl", [
				createV1SessionHeader("session-1"),
				createV1MessageEntry("user", "Hello"),
			]);

			const { runSessionMigration, getMigrationState } =
				await importMigrationModule();
			await runSessionMigration();

			const state = getMigrationState();
			expect(state).not.toBeNull();
			expect(state?.version).toBe(2);
			expect(state?.lastRun).toBeTruthy();
		});

		it("does not re-run if migration state shows current version", async () => {
			writeSessionFile(sessionDir, "test.jsonl", [
				createV1SessionHeader("session-1"),
				createV1MessageEntry("user", "Hello"),
			]);

			// First migration
			const { runSessionMigration, getMigrationState } =
				await importMigrationModule();
			await runSessionMigration();
			const firstState = getMigrationState();

			// Second call with fresh module should see existing state
			const {
				runSessionMigration: runAgain,
				getMigrationState: getStateAgain,
			} = await importMigrationModule();
			await runAgain();
			const secondState = getStateAgain();

			expect(secondState?.lastRun).toBe(firstState?.lastRun);
		});

		it("handles empty session directory gracefully", async () => {
			// Remove all files from session dir
			rmSync(sessionDir, { recursive: true, force: true });
			mkdirSync(sessionDir, { recursive: true });

			const { runSessionMigration } = await importMigrationModule();
			const state = await runSessionMigration();

			expect(state).not.toBeNull();
			expect(state?.total).toBe(0);
		});

		it("handles empty session files gracefully", async () => {
			writeFileSync(join(sessionDir, "empty.jsonl"), "");

			const { runSessionMigration, getMigrationState } =
				await importMigrationModule();
			await runSessionMigration();

			const state = getMigrationState();
			expect(state).not.toBeNull();
		});
	});

	describe("registerActiveSessionFile / unregisterActiveSessionFile", () => {
		it("prevents migration of registered files", async () => {
			const entries = [
				createV1SessionHeader("session-1"),
				createV1MessageEntry("user", "Hello"),
			];
			const filePath = writeSessionFile(sessionDir, "active.jsonl", entries);
			const originalContent = readFileSync(filePath, "utf8");

			const {
				runSessionMigration,
				registerActiveSessionFile,
				unregisterActiveSessionFile,
			} = await importMigrationModule();

			registerActiveSessionFile(filePath);
			await runSessionMigration();

			expect(readFileSync(filePath, "utf8")).toBe(originalContent);

			unregisterActiveSessionFile(filePath);
		});

		it("allows migration after unregistering", async () => {
			const entries = [
				createV1SessionHeader("session-1"),
				createV1MessageEntry("user", "Hello"),
			];
			const filePath = writeSessionFile(sessionDir, "session.jsonl", entries);

			const {
				registerActiveSessionFile,
				unregisterActiveSessionFile,
				resetMigrationState,
			} = await importMigrationModule();

			registerActiveSessionFile(filePath);
			unregisterActiveSessionFile(filePath);
			resetMigrationState();

			// Fresh module import after unregistering
			const { runSessionMigration: runAgain } = await importMigrationModule();
			await runAgain();

			const migrated = readSessionEntries(filePath);
			expect(migrated[0].version).toBe(2);
		});
	});

	describe("resetMigrationState", () => {
		it("forces re-migration on next run", async () => {
			writeSessionFile(sessionDir, "test.jsonl", [
				createV2SessionHeader("session-1"),
				createV2MessageEntry("id1", null, "user", "Hello"),
			]);

			const { runSessionMigration, getMigrationState, resetMigrationState } =
				await importMigrationModule();
			await runSessionMigration();
			const firstState = getMigrationState();
			expect(firstState?.version).toBe(2);

			resetMigrationState();

			const resetState = getMigrationState();
			expect(resetState?.version).toBe(0);

			// Need fresh module to clear migrationPromise
			const {
				runSessionMigration: runAgain,
				getMigrationState: getStateAgain,
			} = await importMigrationModule();
			await runAgain();
			const secondState = getStateAgain();

			// Migration should have run again, updating the version back to current
			expect(secondState?.version).toBe(2);
		});

		it("writes complete state object with all required fields", async () => {
			const { runSessionMigration, resetMigrationState, getMigrationState } =
				await importMigrationModule();
			await runSessionMigration();
			resetMigrationState();

			const state = getMigrationState();
			expect(state).toMatchObject({
				version: 0,
				lastRun: "",
				successes: 0,
				failures: 0,
				normalized: 0,
				skipped: 0,
				total: 0,
			});
		});
	});

	describe("scheduleSessionMigration", () => {
		it("runs migration in background without blocking", async () => {
			writeSessionFile(sessionDir, "test.jsonl", [
				createV1SessionHeader("session-1"),
				createV1MessageEntry("user", "Hello"),
			]);

			const { scheduleSessionMigration } = await importMigrationModule();

			// Should not throw and should return immediately
			scheduleSessionMigration();

			// Multiple calls should be safe
			scheduleSessionMigration();
			scheduleSessionMigration();
		});
	});

	describe("edge cases", () => {
		it("handles session with only header", async () => {
			writeSessionFile(sessionDir, "header-only.jsonl", [
				createV1SessionHeader("session-1"),
			]);

			const { runSessionMigration, getMigrationState } =
				await importMigrationModule();
			await runSessionMigration();

			const state = getMigrationState();
			expect(state).not.toBeNull();
		});

		it("handles mixed v1 and v2 entries", async () => {
			const entries = [
				createV1SessionHeader("session-1"),
				createV2MessageEntry("existing-id", null, "user", "Has ID"),
				createV1MessageEntry("assistant", "No ID"),
			];
			const filePath = writeSessionFile(sessionDir, "mixed.jsonl", entries);

			const { runSessionMigration } = await importMigrationModule();
			await runSessionMigration();

			const migrated = readSessionEntries(filePath);
			expect(migrated[1].id).toBe("existing-id");
			expect(migrated[2].id).toBeTruthy();
			expect(migrated[2].id).not.toBe("existing-id");
		});

		it("preserves non-tree entries (session_meta, attachment_extract)", async () => {
			const entries = [
				createV1SessionHeader("session-1"),
				createV1MessageEntry("user", "Hello"),
				{
					type: "session_meta",
					timestamp: new Date().toISOString(),
					summary: "Test summary",
					favorite: true,
				},
				{
					type: "attachment_extract",
					timestamp: new Date().toISOString(),
					attachmentId: "att-1",
					extractedText: "Extracted content",
				},
			];
			const filePath = writeSessionFile(sessionDir, "with-meta.jsonl", entries);

			const { runSessionMigration } = await importMigrationModule();
			await runSessionMigration();

			const migrated = readSessionEntries(filePath);
			expect(migrated[2].type).toBe("session_meta");
			expect(migrated[2].summary).toBe("Test summary");
			expect(migrated[3].type).toBe("attachment_extract");
			expect(migrated[3].extractedText).toBe("Extracted content");
		});

		it("handles multiple session files in batch", async () => {
			// Create 15 session files to test batching (batch size is 10)
			for (let i = 0; i < 15; i++) {
				writeSessionFile(sessionDir, `session-${i}.jsonl`, [
					createV1SessionHeader(`session-${i}`),
					createV1MessageEntry("user", `Message ${i}`),
				]);
			}

			const { runSessionMigration, getMigrationState } =
				await importMigrationModule();
			await runSessionMigration();

			const state = getMigrationState();
			expect(state?.total).toBe(15);
			expect(state?.normalized).toBe(15);
		});
	});
});
