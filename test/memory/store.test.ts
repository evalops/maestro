import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("memory store session scoping", () => {
	let maestroHome: string;
	let tempRepos: string[];
	let originalMaestroHome: string | undefined;

	beforeEach(() => {
		originalMaestroHome = process.env.MAESTRO_HOME;
		maestroHome = mkdtempSync(join(tmpdir(), "maestro-memory-store-"));
		tempRepos = [];
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
		for (const repo of tempRepos) {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	function createGitRepo(prefix: string): string {
		const root = mkdtempSync(join(tmpdir(), prefix));
		tempRepos.push(root);
		execSync("git init -b main", {
			cwd: root,
			stdio: "ignore",
		});
		return root;
	}

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
		const durableMemories = memory.listAutoDurableMemories();
		expect(durableMemories).toHaveLength(2);
		expect(durableMemories).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: second.entry.id,
					content: "Land changes with green CI.",
					tags: ["auto", "durable", "workflow"],
				}),
				expect.objectContaining({
					content: "Keep PRs focused and land them with green CI.",
					tags: ["auto", "durable", "consolidated", "workflow"],
				}),
			]),
		);
	});

	it("preserves project scope when consolidation upserts omit project name", async () => {
		const memory = await import("../../src/memory/index.js");
		const now = Date.now();
		const legacyScopedEntry = {
			id: "mem_legacy_scoped",
			topic: "team-preferences",
			content: "Keep PRs focused.",
			tags: ["auto", "durable", "workflow"],
			projectId: "project_123",
			createdAt: now,
			updatedAt: now,
		};

		memory.importMemories({
			version: 1,
			entries: [legacyScopedEntry],
		});

		const result = memory.applyAutoMemoryConsolidation({
			removeIds: [legacyScopedEntry.id],
			upserts: [
				{
					topic: "team-preferences",
					content: "Keep PRs focused and land them with green CI.",
					tags: ["workflow"],
				},
			],
			options: {
				projectId: legacyScopedEntry.projectId,
			},
		});

		expect(result).toMatchObject({
			removed: 1,
			added: 1,
			updated: 0,
		});
		expect(
			memory.listAutoDurableMemories({
				projectId: legacyScopedEntry.projectId,
			}),
		).toEqual([
			expect.objectContaining({
				content: "Keep PRs focused and land them with green CI.",
				projectId: legacyScopedEntry.projectId,
				tags: ["auto", "durable", "consolidated", "workflow"],
			}),
		]);
		expect(memory.listAutoDurableMemories({ projectId: null })).toEqual([]);
	});

	it("stores and filters repo-scoped memories independently", async () => {
		const memory = await import("../../src/memory/index.js");
		const repoA = createGitRepo("maestro-memory-repo-a-");
		const repoB = createGitRepo("maestro-memory-repo-b-");

		memory.addMemory("workflow", "Repo A note", { cwd: repoA });
		memory.addMemory("workflow", "Repo B note", { cwd: repoB });

		const repoAProjectId = memory.getMemoryProjectScope(repoA)?.projectId;
		const repoBProjectId = memory.getMemoryProjectScope(repoB)?.projectId;

		expect(repoAProjectId).toBeTruthy();
		expect(repoBProjectId).toBeTruthy();
		expect(repoAProjectId).not.toBe(repoBProjectId);
		expect(
			memory.searchMemories("note", {
				projectId: repoAProjectId,
			}),
		).toEqual([
			expect.objectContaining({
				entry: expect.objectContaining({
					content: "Repo A note",
					projectId: repoAProjectId,
				}),
			}),
		]);
		expect(
			memory.searchMemories("note", {
				projectId: repoBProjectId,
			}),
		).toEqual([
			expect.objectContaining({
				entry: expect.objectContaining({
					content: "Repo B note",
					projectId: repoBProjectId,
				}),
			}),
		]);
	});
});
