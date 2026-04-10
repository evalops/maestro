import { execSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function writeSessionFile(path: string, cwd: string): void {
	const now = new Date("2026-04-07T10:00:00.000Z").toISOString();
	const entries = [
		{
			type: "session",
			version: 2,
			id: "session-123",
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

function writeMalformedSessionFile(path: string): void {
	const now = new Date("2026-04-07T10:00:00.000Z").toISOString();
	const entries = [
		{
			type: "session",
			version: 2,
			id: "session-bad",
			timestamp: now,
			cwd: "/tmp/project",
			subject: "Malformed content",
		},
		{
			type: "message",
			id: "assistant-bad",
			parentId: null,
			timestamp: now,
			message: {
				role: "assistant",
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
	];
	writeFileSync(
		path,
		`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		"utf8",
	);
}

describe("automatic memory extraction", () => {
	let maestroHome: string;
	let repoRoot: string;
	let sessionPath: string;
	let originalMaestroHome: string | undefined;

	beforeEach(() => {
		originalMaestroHome = process.env.MAESTRO_HOME;
		maestroHome = mkdtempSync(join(tmpdir(), "maestro-auto-memory-"));
		repoRoot = mkdtempSync(join(tmpdir(), "maestro-auto-memory-repo-"));
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

	it("extracts durable memories once per session snapshot", async () => {
		const { createAutomaticMemoryExtractionCoordinator } = await import(
			"../../src/memory/auto-extraction.js"
		);
		const memory = await import("../../src/memory/index.js");
		let promptCalls = 0;

		const coordinator = createAutomaticMemoryExtractionCoordinator({
			createAgent: async () => {
				promptCalls += 1;
				const fakeAgent = {
					state: { messages: [] },
					prompt: async (_prompt: string) => {
						const response = JSON.stringify({
							memories: [
								{
									topic: "team-preferences",
									content:
										"Keep pull requests focused and land them with green CI.",
									tags: ["workflow", "review"],
								},
							],
						});
						fakeAgent.state.messages = [
							{
								role: "assistant",
								content: [{ type: "text", text: response }],
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
			onProcessed: undefined,
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
		});

		coordinator.schedule(sessionPath);
		await coordinator.flush();

		expect(promptCalls).toBe(1);
		expect(memory.getTopicMemories("team-preferences")).toEqual([
			expect.objectContaining({
				content: "Keep pull requests focused and land them with green CI.",
				projectName: expect.any(String),
				projectId: expect.any(String),
				tags: ["auto", "durable", "review", "workflow"],
			}),
		]);

		coordinator.schedule(sessionPath);
		await coordinator.flush();

		expect(promptCalls).toBe(1);
	}, 60_000);

	it("calls onProcessed after a successful extraction pass", async () => {
		const { createAutomaticMemoryExtractionCoordinator } = await import(
			"../../src/memory/auto-extraction.js"
		);
		const onProcessed = vi.fn();

		const coordinator = createAutomaticMemoryExtractionCoordinator({
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
											memories: [
												{
													topic: "team-preferences",
													content: "Keep PRs focused.",
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
			onProcessed,
			sessionManager: {
				getSessionFile: () => sessionPath,
				flush: async () => {},
				saveSessionMemoryExtractionHash: () => {},
			},
		});

		coordinator.schedule(sessionPath);
		await coordinator.flush();

		expect(onProcessed).toHaveBeenCalledTimes(1);
	});

	it("mirrors extracted durable memories to the remote memory service", async () => {
		const upsertRemoteDurableMemory = vi.fn().mockResolvedValue({
			created: true,
			updated: false,
			entry: {
				id: "mem_remote_1",
				topic: "team-preferences",
				content: "Keep PRs focused.",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
		});
		vi.doMock("../../src/memory/service-client.js", () => ({
			upsertRemoteDurableMemory,
		}));

		const { createAutomaticMemoryExtractionCoordinator } = await import(
			"../../src/memory/auto-extraction.js"
		);

		const coordinator = createAutomaticMemoryExtractionCoordinator({
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
											memories: [
												{
													topic: "team-preferences",
													content: "Keep PRs focused.",
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
			onProcessed: undefined,
			sessionManager: {
				getSessionFile: () => sessionPath,
				flush: async () => {},
				saveSessionMemoryExtractionHash: () => {},
			},
		});

		coordinator.schedule(sessionPath);
		await coordinator.flush();

		expect(upsertRemoteDurableMemory).toHaveBeenCalledWith(
			"team-preferences",
			"Keep PRs focused.",
			{
				tags: ["auto", "durable", "workflow"],
				cwd: repoRoot,
			},
		);
	});

	it("swallows malformed session snapshot errors during flush", async () => {
		const malformedSessionPath = join(maestroHome, "malformed-session.jsonl");
		writeMalformedSessionFile(malformedSessionPath);
		const { createAutomaticMemoryExtractionCoordinator } = await import(
			"../../src/memory/auto-extraction.js"
		);
		const createAgent = vi.fn();

		const coordinator = createAutomaticMemoryExtractionCoordinator({
			createAgent: async () => {
				createAgent();
				throw new Error("should not reach extractor");
			},
			getModel: () =>
				({
					id: "gpt-4o-mini",
					provider: "openai",
					api: "openai-responses",
				}) as never,
			onProcessed: undefined,
			sessionManager: {
				getSessionFile: () => malformedSessionPath,
				flush: async () => {},
				saveSessionMemoryExtractionHash: () => {},
			},
		});

		coordinator.schedule(malformedSessionPath);
		await expect(coordinator.flush()).resolves.toBeUndefined();
		expect(createAgent).not.toHaveBeenCalled();
	});

	it("exposes a non-empty extraction system prompt", async () => {
		const { getMemoryExtractionSystemPrompt } = await import(
			"../../src/memory/auto-extraction.js"
		);
		expect(getMemoryExtractionSystemPrompt()).toContain(
			"durable cross-session memory",
		);
	});
});
