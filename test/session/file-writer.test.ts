/**
 * Tests for SessionFileWriter - Buffered JSONL writer
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionFileWriter } from "../../src/session/file-writer.js";
import type { SessionEntry } from "../../src/session/types.js";

// Helper to create a simple entry that satisfies SessionEntry union
function createMessageEntry(content: string): SessionEntry {
	return {
		type: "thinking_level_change",
		timestamp: new Date().toISOString(),
		thinkingLevel: content, // Use thinkingLevel to store test content
	};
}

function createSessionEntry(id: string): SessionEntry {
	return {
		type: "session",
		id,
		timestamp: new Date().toISOString(),
		cwd: "/test",
		model: "test/model",
		thinkingLevel: "off",
	};
}

describe("SessionFileWriter", () => {
	let testDir: string;
	let testFile: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `session-writer-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		testFile = join(testDir, "test-session.jsonl");
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("creates file on first flush", () => {
		const writer = new SessionFileWriter(testFile);
		const entry = createMessageEntry("Hello");

		writer.write(entry);
		expect(existsSync(testFile)).toBe(false);

		writer.flushSync();
		expect(existsSync(testFile)).toBe(true);

		const contents = readFileSync(testFile, "utf8");
		expect(contents).toContain('"type":"thinking_level_change"');
		writer.dispose();
	});

	it("buffers writes until flush", () => {
		const writer = new SessionFileWriter(testFile, 10); // High batch size
		const entry1 = createMessageEntry("First");
		const entry2 = createMessageEntry("Second");

		writer.write(entry1);
		writer.write(entry2);

		// File should not exist yet (buffered)
		expect(existsSync(testFile)).toBe(false);

		writer.flushSync();

		const contents = readFileSync(testFile, "utf8");
		const lines = contents.trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("First");
		expect(lines[1]).toContain("Second");
		writer.dispose();
	});

	it("auto-flushes when batch size is reached", () => {
		const writer = new SessionFileWriter(testFile, 2); // Small batch size

		writer.write(createMessageEntry("One"));
		expect(existsSync(testFile)).toBe(false);

		writer.write(createMessageEntry("Two"));

		// Should auto-flush after 2 entries
		expect(existsSync(testFile)).toBe(true);
		const contents = readFileSync(testFile, "utf8");
		expect(contents).toContain("One");
		expect(contents).toContain("Two");
		writer.dispose();
	});

	it("handles async flush", async () => {
		const writer = new SessionFileWriter(testFile);
		writer.write(createSessionEntry("test-id"));

		await writer.flush();

		expect(existsSync(testFile)).toBe(true);
		const contents = readFileSync(testFile, "utf8");
		expect(contents).toContain("test-id");
		writer.dispose();
	});

	it("dispose removes writer from registry", () => {
		const writer = new SessionFileWriter(testFile);
		writer.write(createMessageEntry("Test"));

		// Dispose should not throw
		writer.dispose();

		// Can still flush after dispose (just removes from registry)
		writer.flushSync();
		expect(existsSync(testFile)).toBe(true);
	});

	it("handles multiple flushes correctly", () => {
		const writer = new SessionFileWriter(testFile);

		writer.write(createMessageEntry("First batch"));
		writer.flushSync();

		writer.write(createMessageEntry("Second batch"));
		writer.flushSync();

		const contents = readFileSync(testFile, "utf8");
		const lines = contents.trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("First batch");
		expect(lines[1]).toContain("Second batch");
		writer.dispose();
	});

	it("handles empty flushSync gracefully", () => {
		const writer = new SessionFileWriter(testFile);

		// Flush with nothing buffered should not create file
		writer.flushSync();
		expect(existsSync(testFile)).toBe(false);

		writer.dispose();
	});
});
