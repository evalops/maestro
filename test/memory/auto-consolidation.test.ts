import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("automatic memory consolidation", () => {
	let maestroHome: string;
	let originalMaestroHome: string | undefined;
	let originalMinMemories: string | undefined;
	let originalMinHours: string | undefined;

	beforeEach(() => {
		originalMaestroHome = process.env.MAESTRO_HOME;
		originalMinMemories = process.env.MAESTRO_MEMORY_CONSOLIDATION_MIN_MEMORIES;
		originalMinHours = process.env.MAESTRO_MEMORY_CONSOLIDATION_MIN_HOURS;
		maestroHome = mkdtempSync(join(tmpdir(), "maestro-auto-consolidation-"));
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
	});

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
});
