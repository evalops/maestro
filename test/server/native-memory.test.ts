import { execSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createNativeMemoryNoopCoordinators,
	noopAutomaticMemoryExtraction,
} from "../../src/server/native-memory-noop.js";
import {
	createNativeMemoryCoordinators,
	createNativeMemoryExtractionCoordinator,
} from "../../src/server/native-memory.js";

function writeSessionFile(path: string, cwd: string): void {
	const now = new Date("2026-04-07T10:00:00.000Z").toISOString();
	const entries = [
		{
			type: "session",
			version: 2,
			id: "session-native-memory-1",
			timestamp: now,
			cwd,
			subject: "Tighten repo workflows",
		},
		{
			type: "message",
			id: "user-1",
			parentId: null,
			timestamp: now,
			message: {
				role: "user",
				content:
					"Please keep pull requests focused, always land with green CI, and prefer small reviewable slices.",
				timestamp: Date.parse(now),
			},
		},
		{
			type: "message",
			id: "assistant-1",
			parentId: "user-1",
			timestamp: now,
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Understood. I'll keep slices tight." },
				],
				timestamp: Date.parse(now),
				api: "openai-responses",
				provider: "openai",
				model: "gpt-4o-mini",
				stopReason: "stop",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0,
					},
				},
			},
		},
		{
			type: "session_meta",
			timestamp: now,
			summary:
				"Reviewed the workflow expectations and captured the repo preference for small, green, reviewable changes.",
			resumeSummary:
				"Keep future work in small reviewable PRs, maintain green CI before merge, and avoid mixing unrelated changes.",
		},
	];
	writeFileSync(
		path,
		`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		"utf8",
	);
}

describe("native-memory coordinators", () => {
	let maestroHome: string;
	let repoRoot: string;
	let sessionPath: string;
	let originalMaestroHome: string | undefined;

	beforeEach(() => {
		originalMaestroHome = process.env.MAESTRO_HOME;
		maestroHome = mkdtempSync(join(tmpdir(), "maestro-native-memory-"));
		repoRoot = mkdtempSync(join(tmpdir(), "maestro-native-memory-repo-"));
		execSync("git init -b main", {
			cwd: repoRoot,
			stdio: "ignore",
		});
		process.env.MAESTRO_HOME = maestroHome;
		sessionPath = join(maestroHome, "session.jsonl");
		writeSessionFile(sessionPath, repoRoot);
		vi.resetModules();
	});

	afterEach(() => {
		if (originalMaestroHome === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_HOME");
		} else {
			process.env.MAESTRO_HOME = originalMaestroHome;
		}
		rmSync(repoRoot, { recursive: true, force: true });
		rmSync(maestroHome, { recursive: true, force: true });
	});

	it("extracts durable memories via injected native one-shot runner", async () => {
		const memory = await import("../../src/memory/index.js");
		let promptCalls = 0;
		const runNativeBackgroundPrompt = vi.fn(
			async (options: { prompt: string; systemPrompt?: string }) => {
				promptCalls += 1;
				expect(options.systemPrompt).toContain("extract durable");
				expect(options.prompt).toContain("Session snapshot");
				return {
					ok: true as const,
					text: JSON.stringify({
						memories: [
							{
								topic: "team-preferences",
								content:
									"Keep pull requests focused and land them with green CI.",
								tags: ["workflow", "review"],
							},
						],
					}),
				};
			},
		);

		const coordinator = createNativeMemoryExtractionCoordinator({
			sessionManager: {
				getSessionFile: () => sessionPath,
				flush: async () => {},
				saveSessionMemoryExtractionHash: (hash: string) => {
					appendFileSync(
						sessionPath,
						`${JSON.stringify({
							type: "session_meta",
							timestamp: new Date().toISOString(),
							memoryExtractionHash: hash,
						})}\n`,
						"utf8",
					);
				},
			},
			model: { id: "gpt-4o-mini", provider: "openai" },
			cwd: repoRoot,
			runNativeBackgroundPrompt,
		});

		coordinator.schedule(sessionPath);
		await coordinator.flush();

		expect(promptCalls).toBe(1);
		expect(runNativeBackgroundPrompt).toHaveBeenCalledTimes(1);
		expect(memory.getTopicMemories("team-preferences")).toEqual([
			expect.objectContaining({
				content: "Keep pull requests focused and land them with green CI.",
				tags: ["auto", "durable", "review", "workflow"],
			}),
		]);
	});

	it("logs and continues when native one-shot fails (no throw to caller)", async () => {
		const runNativeBackgroundPrompt = vi.fn(async () => ({
			ok: false as const,
			error: new Error("spawn failed"),
			phase: "start" as const,
		}));

		const coordinator = createNativeMemoryExtractionCoordinator({
			sessionManager: {
				getSessionFile: () => sessionPath,
				flush: async () => {},
				saveSessionMemoryExtractionHash: () => {},
			},
			model: { id: "gpt-4o-mini", provider: "openai" },
			cwd: repoRoot,
			runNativeBackgroundPrompt,
		});

		coordinator.schedule(sessionPath);
		// auto-extraction catches errors and logs; flush must not throw
		await expect(coordinator.flush()).resolves.toBeUndefined();
		expect(runNativeBackgroundPrompt).toHaveBeenCalled();
	});

	it("createNativeMemoryCoordinators returns no-ops when MAESTRO_NATIVE_MEMORY is off", () => {
		const pair = createNativeMemoryCoordinators({
			sessionManager: {
				getSessionFile: () => sessionPath,
				flush: async () => {},
				saveSessionMemoryExtractionHash: () => {},
			},
			model: { id: "gpt-4o-mini", provider: "openai" },
			env: { MAESTRO_NATIVE_MEMORY: "0" },
		});
		const noops = createNativeMemoryNoopCoordinators();
		expect(pair.extraction).toBe(noops.extraction);
		expect(pair.consolidation).toBe(noops.consolidation);
		expect(pair.extraction).toBe(noopAutomaticMemoryExtraction);
	});
});
