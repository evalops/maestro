/**
 * Tests for SessionMetadataCache - In-memory session metadata tracking
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionMetadataCache } from "../../src/session/metadata-cache.js";
import type { SessionEntry } from "../../src/session/types.js";

// Helper to create a valid session entry for testing
function createSessionEntry(
	overrides: Partial<SessionEntry & { type: "session" }> = {},
): SessionEntry {
	return {
		type: "session",
		id: "test-id",
		timestamp: new Date().toISOString(),
		cwd: "/test",
		model: "anthropic/claude-opus-4-6",
		thinkingLevel: "off",
		...overrides,
	};
}

describe("SessionMetadataCache", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `metadata-cache-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe("apply", () => {
		it("extracts thinking level from session entry", () => {
			const cache = new SessionMetadataCache();
			const entry = createSessionEntry({ thinkingLevel: "high" });

			cache.apply(entry);

			expect(cache.getThinkingLevel()).toBe("high");
		});

		it("extracts model from session entry", () => {
			const cache = new SessionMetadataCache();
			const entry = createSessionEntry({
				model: "anthropic/claude-opus-4-6",
			});

			cache.apply(entry);

			expect(cache.getModel()).toBe("anthropic/claude-opus-4-6");
		});

		it("extracts model metadata from session entry", () => {
			const cache = new SessionMetadataCache();
			const entry = createSessionEntry({
				model: "anthropic/claude-sonnet-4-20250514",
				thinkingLevel: "medium",
				modelMetadata: {
					provider: "anthropic",
					modelId: "claude-sonnet-4-20250514",
					name: "Claude 4 Sonnet",
					reasoning: true,
					contextWindow: 200000,
				},
			});

			cache.apply(entry);

			const metadata = cache.getModelMetadata();
			expect(metadata).toBeDefined();
			expect(metadata?.provider).toBe("anthropic");
			expect(metadata?.modelId).toBe("claude-sonnet-4-20250514");
			expect(metadata?.reasoning).toBe(true);
		});

		it("updates thinking level from thinking_level_change entry", () => {
			const cache = new SessionMetadataCache();

			cache.apply(createSessionEntry({ thinkingLevel: "off" }));
			expect(cache.getThinkingLevel()).toBe("off");

			cache.apply({
				type: "thinking_level_change",
				id: "thinking-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				thinkingLevel: "max",
			});

			expect(cache.getThinkingLevel()).toBe("max");
		});

		it("updates model from model_change entry", () => {
			const cache = new SessionMetadataCache();

			cache.apply(
				createSessionEntry({ model: "anthropic/claude-sonnet-4-20250514" }),
			);
			expect(cache.getModel()).toBe("anthropic/claude-sonnet-4-20250514");

			cache.apply({
				type: "model_change",
				id: "model-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				model: "openai/gpt-4o",
				modelMetadata: {
					provider: "openai",
					modelId: "gpt-4o",
					name: "GPT-4o",
				},
			});

			expect(cache.getModel()).toBe("openai/gpt-4o");
			expect(cache.getModelMetadata()?.provider).toBe("openai");
		});

		it("ignores irrelevant entry types", () => {
			const cache = new SessionMetadataCache();

			// Use thinking_level_change as a proxy for testing non-session entries
			// since message entries require complex AppMessage types
			cache.apply({
				type: "session_meta",
				timestamp: new Date().toISOString(),
				summary: "Test summary",
			});

			expect(cache.getThinkingLevel()).toBe("off"); // Default
			expect(cache.getModel()).toBeNull();
		});
	});

	describe("seedFromFile", () => {
		it("loads metadata from existing session file", () => {
			const testFile = join(testDir, "session.jsonl");
			// Use raw JSON that represents valid entries - file parsing is lenient
			const entries = [
				{
					type: "session",
					id: "test-session",
					timestamp: "2024-01-01T00:00:00Z",
					cwd: "/test",
					model: "anthropic/claude-opus-4-6",
					thinkingLevel: "medium",
				},
				{
					type: "thinking_level_change",
					timestamp: "2024-01-01T00:00:02Z",
					thinkingLevel: "high",
				},
			];

			writeFileSync(testFile, entries.map((e) => JSON.stringify(e)).join("\n"));

			const cache = new SessionMetadataCache();
			cache.seedFromFile(testFile);

			expect(cache.getModel()).toBe("anthropic/claude-opus-4-6");
			expect(cache.getThinkingLevel()).toBe("high"); // Updated by change entry
		});

		it("handles non-existent file gracefully", () => {
			const cache = new SessionMetadataCache();
			const nonExistentFile = join(testDir, "does-not-exist.jsonl");

			// Should not throw
			cache.seedFromFile(nonExistentFile);

			expect(cache.getThinkingLevel()).toBe("off");
			expect(cache.getModel()).toBeNull();
		});

		it("handles empty file gracefully", () => {
			const testFile = join(testDir, "empty.jsonl");
			writeFileSync(testFile, "");

			const cache = new SessionMetadataCache();
			cache.seedFromFile(testFile);

			expect(cache.getThinkingLevel()).toBe("off");
			expect(cache.getModel()).toBeNull();
		});

		it("handles malformed JSON lines gracefully", () => {
			const testFile = join(testDir, "malformed.jsonl");
			const content = [
				JSON.stringify({
					type: "session",
					id: "test",
					timestamp: "2024-01-01T00:00:00Z",
					cwd: "/test",
					model: "anthropic/claude-opus-4-6",
					thinkingLevel: "off",
				}),
				"{ invalid json",
				JSON.stringify({
					type: "thinking_level_change",
					timestamp: "2024-01-01T00:00:01Z",
					thinkingLevel: "high",
				}),
			].join("\n");

			writeFileSync(testFile, content);

			const cache = new SessionMetadataCache();
			cache.seedFromFile(testFile);

			// Should parse valid entries and skip invalid ones
			expect(cache.getModel()).toBe("anthropic/claude-opus-4-6");
			expect(cache.getThinkingLevel()).toBe("high");
		});
	});

	describe("reset", () => {
		it("resets cache to initial state", () => {
			const cache = new SessionMetadataCache();

			cache.apply(
				createSessionEntry({
					model: "anthropic/claude-opus-4-6",
					thinkingLevel: "high",
					modelMetadata: {
						provider: "anthropic",
						modelId: "claude-opus-4-6",
					},
				}),
			);

			expect(cache.getModel()).toBe("anthropic/claude-opus-4-6");
			expect(cache.getThinkingLevel()).toBe("high");
			expect(cache.getModelMetadata()).toBeDefined();

			cache.reset();

			expect(cache.getModel()).toBeNull();
			expect(cache.getThinkingLevel()).toBe("off");
			expect(cache.getModelMetadata()).toBeUndefined();
		});
	});
});
