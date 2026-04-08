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

	it("upserts durable memories by normalized topic and content", async () => {
		const memory = await import("../../src/memory/index.js");

		const first = memory.upsertDurableMemory(
			"Team-Preferences",
			"Prefer focused PRs with green CI.",
			{
				tags: ["Review"],
			},
		);
		const second = memory.upsertDurableMemory(
			"team-preferences",
			"Prefer   focused PRs with green CI.",
			{
				tags: ["durable", "review"],
			},
		);

		expect(first.entry.id).toBe(second.entry.id);
		expect(second.created).toBe(false);
		expect(second.updated).toBe(true);
		expect(memory.getTopicMemories("team-preferences")).toEqual([
			expect.objectContaining({
				id: first.entry.id,
				content: "Prefer focused PRs with green CI.",
				tags: ["durable", "review"],
			}),
		]);
	});

	it("lists only automatic durable global memories", async () => {
		const memory = await import("../../src/memory/index.js");

		memory.addMemory("manual-note", "Keep this manual note.", {
			tags: ["durable"],
		});
		memory.addMemory("session-memory", "Session-only note.", {
			sessionId: "sess_1",
			tags: ["auto", "durable"],
		});
		const durable = memory.upsertDurableMemory(
			"team-preferences",
			"Keep PRs focused.",
			{
				tags: ["auto", "durable", "workflow"],
			},
		);

		expect(memory.listAutoDurableMemories()).toEqual([
			expect.objectContaining({
				id: durable.entry.id,
				topic: "team-preferences",
				tags: ["auto", "durable", "workflow"],
			}),
		]);
	});

	it("applies automatic consolidation only to eligible auto durable memories", async () => {
		const memory = await import("../../src/memory/index.js");

		const first = memory.upsertDurableMemory(
			"team-preferences",
			"Keep PRs focused.",
			{
				tags: ["auto", "durable", "workflow"],
			},
		);
		const second = memory.upsertDurableMemory(
			"team-preferences",
			"Land changes with green CI.",
			{
				tags: ["auto", "durable", "workflow"],
			},
		);
		const protectedEntry = memory.addMemory(
			"manual-note",
			"Do not touch this.",
			{
				tags: ["manual"],
			},
		);

		const result = memory.applyAutoMemoryConsolidation({
			removeIds: [first.entry.id, protectedEntry.id],
			upserts: [
				{
					topic: "team-preferences",
					content: "Keep PRs focused and land them with green CI.",
					tags: ["workflow"],
				},
			],
		});

		expect(result).toMatchObject({
			removed: 1,
			added: 1,
			updated: 0,
		});
		expect(memory.getMemory(protectedEntry.id)).toEqual(
			expect.objectContaining({
				id: protectedEntry.id,
				content: "Do not touch this.",
			}),
		);
		expect(memory.listAutoDurableMemories()).toEqual([
			expect.objectContaining({
				id: second.entry.id,
				content: "Land changes with green CI.",
				tags: ["auto", "durable", "workflow"],
			}),
			expect.objectContaining({
				content: "Keep PRs focused and land them with green CI.",
				tags: ["auto", "durable", "consolidated", "workflow"],
			}),
		]);
	});
});
