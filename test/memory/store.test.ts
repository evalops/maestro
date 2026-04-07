import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("memory store session scoping", () => {
	let maestroHome: string;
	let originalMaestroHome: string | undefined;

	beforeEach(() => {
		originalMaestroHome = process.env.MAESTRO_HOME;
		maestroHome = mkdtempSync(join(tmpdir(), "maestro-memory-store-"));
		process.env.MAESTRO_HOME = maestroHome;
		vi.resetModules();
	});

	afterEach(() => {
		if (originalMaestroHome === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_HOME");
		} else {
			process.env.MAESTRO_HOME = originalMaestroHome;
		}
		rmSync(maestroHome, { recursive: true, force: true });
	});

	it("filters queries by session id", async () => {
		const memory = await import("../../src/memory/index.js");

		memory.addMemory("api-design", "Global conventions", {
			tags: ["rest"],
		});
		memory.addMemory("api-design", "Session-specific conventions", {
			tags: ["rest"],
			sessionId: "sess_1",
		});
		memory.addMemory("debugging", "Other session note", {
			sessionId: "sess_2",
		});

		expect(memory.listTopics({ sessionId: "sess_1" })).toEqual([
			expect.objectContaining({
				name: "api-design",
				entryCount: 1,
			}),
		]);
		expect(
			memory.getTopicMemories("api-design", { sessionId: "sess_1" }),
		).toEqual([
			expect.objectContaining({
				content: "Session-specific conventions",
				sessionId: "sess_1",
			}),
		]);
		expect(
			memory.searchMemories("Session-specific", { sessionId: "sess_1" }),
		).toHaveLength(1);
		expect(memory.getRecentMemories(10, { sessionId: "sess_1" })).toEqual([
			expect.objectContaining({
				sessionId: "sess_1",
			}),
		]);
		expect(memory.getStats({ sessionId: "sess_1" })).toMatchObject({
			totalEntries: 1,
			topics: 1,
		});
	});

	it("upserts scoped memories without duplicating entries", async () => {
		const memory = await import("../../src/memory/index.js");

		const first = memory.upsertScopedMemory("session-memory", "first state", {
			sessionId: "sess_1",
			tags: ["session"],
		});
		const second = memory.upsertScopedMemory("session-memory", "next state", {
			sessionId: "sess_1",
			tags: ["session", "summary"],
		});

		expect(second.id).toBe(first.id);
		expect(
			memory.getTopicMemories("session-memory", { sessionId: "sess_1" }),
		).toEqual([
			expect.objectContaining({
				id: first.id,
				content: "next state",
				tags: ["session", "summary"],
			}),
		]);
	});
});
