import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("automatic memory consolidation", () => {
	let maestroHome: string;
	let tempRepos: string[];
	let originalMaestroHome: string | undefined;
	let originalMinMemories: string | undefined;
	let originalMinHours: string | undefined;

	beforeEach(() => {
		originalMaestroHome = process.env.MAESTRO_HOME;
		originalMinMemories = process.env.MAESTRO_MEMORY_CONSOLIDATION_MIN_MEMORIES;
		originalMinHours = process.env.MAESTRO_MEMORY_CONSOLIDATION_MIN_HOURS;
		maestroHome = mkdtempSync(join(tmpdir(), "maestro-auto-consolidation-"));
		tempRepos = [];
		process.env.MAESTRO_HOME = maestroHome;
		process.env.MAESTRO_MEMORY_CONSOLIDATION_MIN_MEMORIES = "1";
		process.env.MAESTRO_MEMORY_CONSOLIDATION_MIN_HOURS = "0";
		vi.resetModules();
	});

	afterEach(() => {
		if (originalMaestroHome === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_HOME");
		} else {
			process.env.MAESTRO_HOME = originalMaestroHome;
		}
		if (originalMinMemories === undefined) {
			Reflect.deleteProperty(
				process.env,
				"MAESTRO_MEMORY_CONSOLIDATION_MIN_MEMORIES",
			);
		} else {
			process.env.MAESTRO_MEMORY_CONSOLIDATION_MIN_MEMORIES =
				originalMinMemories;
		}
		if (originalMinHours === undefined) {
			Reflect.deleteProperty(
				process.env,
				"MAESTRO_MEMORY_CONSOLIDATION_MIN_HOURS",
			);
		} else {
			process.env.MAESTRO_MEMORY_CONSOLIDATION_MIN_HOURS = originalMinHours;
		}
		rmSync(maestroHome, { recursive: true, force: true });
		for (const repo of tempRepos) {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	function createGitRepo(prefix: string): string {
		const repoRoot = mkdtempSync(join(tmpdir(), prefix));
		tempRepos.push(repoRoot);
		execSync("git init -b main", {
			cwd: repoRoot,
			stdio: "ignore",
		});
		return repoRoot;
	}

	it("consolidates auto durable memories and remembers the final source hash", async () => {
		const memory = await import("../../src/memory/index.js");
		const { createAutomaticMemoryConsolidationCoordinator } = await import(
			"../../src/memory/auto-consolidation.js"
		);

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

		let promptCalls = 0;
		const coordinator = createAutomaticMemoryConsolidationCoordinator({
			createAgent: async () => {
				promptCalls += 1;
				const fakeAgent = {
					state: { messages: [] },
					prompt: async () => {
						fakeAgent.state.messages = [
							{
								role: "assistant",
								content: [
									{
										type: "text",
										text: JSON.stringify({
											removeIds: [first.entry.id, second.entry.id],
											upserts: [
												{
													topic: "team-preferences",
													content:
														"Keep PRs focused and land them with green CI.",
													tags: ["workflow"],
												},
											],
										}),
									},
								],
							},
						];
					},
				};
				return fakeAgent as never;
			},
			getModel: () =>
				({
					id: "gpt-4o-mini",
					provider: "openai",
					api: "openai-responses",
				}) as never,
		});

		coordinator.schedule();
		await coordinator.flush();

		expect(promptCalls).toBe(1);
		expect(memory.listAutoDurableMemories()).toEqual([
			expect.objectContaining({
				topic: "team-preferences",
				content: "Keep PRs focused and land them with green CI.",
				tags: ["auto", "durable", "consolidated", "workflow"],
			}),
		]);

		coordinator.schedule();
		await coordinator.flush();

		expect(promptCalls).toBe(1);
	});

	it("exposes a non-empty consolidation system prompt", async () => {
		const { getMemoryConsolidationSystemPrompt } = await import(
			"../../src/memory/auto-consolidation.js"
		);
		expect(getMemoryConsolidationSystemPrompt()).toContain(
			"consolidate automatic durable memories",
		);
	});

	it("mirrors consolidation plans to the remote memory service", async () => {
		const applyRemoteAutoMemoryConsolidation = vi.fn().mockResolvedValue({
			removed: 2,
			added: 1,
			updated: 0,
		});
		vi.doMock("../../src/memory/service-client.js", () => ({
			applyRemoteAutoMemoryConsolidation,
		}));

		const memory = await import("../../src/memory/index.js");
		const { createAutomaticMemoryConsolidationCoordinator } = await import(
			"../../src/memory/auto-consolidation.js"
		);

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

		const coordinator = createAutomaticMemoryConsolidationCoordinator({
			createAgent: async () => {
				const fakeAgent = {
					state: { messages: [] },
					prompt: async () => {
						fakeAgent.state.messages = [
							{
								role: "assistant",
								content: [
									{
										type: "text",
										text: JSON.stringify({
											removeIds: [first.entry.id, second.entry.id],
											upserts: [
												{
													topic: "team-preferences",
													content:
														"Keep PRs focused and land them with green CI.",
													tags: ["workflow"],
												},
											],
										}),
									},
								],
							},
						];
					},
				};
				return fakeAgent as never;
			},
			getModel: () =>
				({
					id: "gpt-4o-mini",
					provider: "openai",
					api: "openai-responses",
				}) as never,
		});

		coordinator.schedule();
		await coordinator.flush();

		expect(applyRemoteAutoMemoryConsolidation).toHaveBeenCalledWith(
			expect.objectContaining({
				removeEntries: expect.arrayContaining([
					expect.objectContaining({ content: "Keep PRs focused." }),
					expect.objectContaining({
						content: "Land changes with green CI.",
					}),
				]),
				upserts: expect.arrayContaining([
					expect.objectContaining({
						topic: "team-preferences",
						content: "Keep PRs focused and land them with green CI.",
					}),
				]),
			}),
		);
	});

	it("consolidates automatic durable memories per repo scope", async () => {
		const memory = await import("../../src/memory/index.js");
		const { createAutomaticMemoryConsolidationCoordinator } = await import(
			"../../src/memory/auto-consolidation.js"
		);
		const repoA = createGitRepo("maestro-consolidation-repo-a-");
		const repoB = createGitRepo("maestro-consolidation-repo-b-");

		const repoAFirst = memory.upsertDurableMemory("deploy", "Repo A first.", {
			cwd: repoA,
			tags: ["auto", "durable", "workflow"],
		});
		const repoASecond = memory.upsertDurableMemory("deploy", "Repo A second.", {
			cwd: repoA,
			tags: ["auto", "durable", "workflow"],
		});
		const repoBFirst = memory.upsertDurableMemory("deploy", "Repo B first.", {
			cwd: repoB,
			tags: ["auto", "durable", "workflow"],
		});
		const repoBSecond = memory.upsertDurableMemory("deploy", "Repo B second.", {
			cwd: repoB,
			tags: ["auto", "durable", "workflow"],
		});

		let promptCalls = 0;
		const coordinator = createAutomaticMemoryConsolidationCoordinator({
			createAgent: async () => {
				promptCalls += 1;
				const fakeAgent = {
					state: { messages: [] },
					prompt: async (prompt: string) => {
						const removeIds = prompt.includes("Repo A")
							? [repoAFirst.entry.id, repoASecond.entry.id]
							: [repoBFirst.entry.id, repoBSecond.entry.id];
						const content = prompt.includes("Repo A")
							? "Repo A canonical."
							: "Repo B canonical.";
						fakeAgent.state.messages = [
							{
								role: "assistant",
								content: [
									{
										type: "text",
										text: JSON.stringify({
											removeIds,
											upserts: [
												{
													topic: "deploy",
													content,
													tags: ["workflow"],
												},
											],
										}),
									},
								],
							},
						];
					},
				};
				return fakeAgent as never;
			},
			getModel: () =>
				({
					id: "gpt-4o-mini",
					provider: "openai",
					api: "openai-responses",
				}) as never,
		});

		coordinator.schedule();
		await coordinator.flush();

		expect(promptCalls).toBe(2);
		expect(
			memory.listAutoDurableMemories({
				projectId: memory.getMemoryProjectScope(repoA)?.projectId,
			}),
		).toEqual([
			expect.objectContaining({
				content: "Repo A canonical.",
				projectName: expect.any(String),
			}),
		]);
		expect(
			memory.listAutoDurableMemories({
				projectId: memory.getMemoryProjectScope(repoB)?.projectId,
			}),
		).toEqual([
			expect.objectContaining({
				content: "Repo B canonical.",
				projectName: expect.any(String),
			}),
		]);
	});

	it("preserves legacy global consolidation state after a project-scoped run", async () => {
		process.env.MAESTRO_MEMORY_CONSOLIDATION_MIN_HOURS = "24";
		vi.resetModules();

		const memory = await import("../../src/memory/index.js");
		const { createAutomaticMemoryConsolidationCoordinator } = await import(
			"../../src/memory/auto-consolidation.js"
		);
		const repo = createGitRepo("maestro-consolidation-repo-");
		const memoryDir = join(maestroHome, "memory");
		mkdirSync(memoryDir, { recursive: true });
		writeFileSync(
			join(memoryDir, "consolidation-state.json"),
			JSON.stringify({
				lastConsolidatedAt: Date.now(),
				lastSourceHash: "legacy-global-hash",
			}),
			"utf8",
		);

		memory.upsertDurableMemory("global", "Global memory.", {
			tags: ["auto", "durable", "workflow"],
		});
		memory.upsertDurableMemory("repo", "Repo memory.", {
			cwd: repo,
			tags: ["auto", "durable", "workflow"],
		});

		let promptCalls = 0;
		const coordinator = createAutomaticMemoryConsolidationCoordinator({
			createAgent: async () => {
				promptCalls += 1;
				const fakeAgent = {
					state: { messages: [] },
					prompt: async () => {
						fakeAgent.state.messages = [
							{
								role: "assistant",
								content: [
									{
										type: "text",
										text: JSON.stringify({
											removeIds: [],
											upserts: [],
										}),
									},
								],
							},
						];
					},
				};
				return fakeAgent as never;
			},
			getModel: () =>
				({
					id: "gpt-4o-mini",
					provider: "openai",
					api: "openai-responses",
				}) as never,
		});

		coordinator.schedule();
		await coordinator.flush();
		expect(promptCalls).toBe(1);

		coordinator.schedule();
		await coordinator.flush();
		expect(promptCalls).toBe(1);
	});
});
