import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	addMemory,
	getMemoryProjectScope,
	upsertScopedMemory,
} from "../../src/memory/index.js";
import {
	buildRelevantMemoryPromptAddition,
	buildRelevantMemoryPromptAdditionAsync,
} from "../../src/memory/relevant-recall.js";

describe("relevant memory recall", () => {
	let tempRoot: string;
	let repoRoots: string[];
	let originalMaestroHome: string | undefined;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "maestro-memory-recall-"));
		repoRoots = [];
		originalMaestroHome = process.env.MAESTRO_HOME;
		process.env.MAESTRO_HOME = join(tempRoot, ".maestro-home");
	});

	afterEach(() => {
		Reflect.deleteProperty(process.env, "MAESTRO_MEMORY_BASE");
		Reflect.deleteProperty(process.env, "MAESTRO_MEMORY_ACCESS_TOKEN");
		Reflect.deleteProperty(process.env, "MAESTRO_EVALOPS_ORG_ID");
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		if (originalMaestroHome === undefined) {
			delete process.env.MAESTRO_HOME;
		} else {
			process.env.MAESTRO_HOME = originalMaestroHome;
		}
		for (const repoRoot of repoRoots) {
			rmSync(repoRoot, { recursive: true, force: true });
		}
		rmSync(tempRoot, { recursive: true, force: true });
	});

	function createGitRepo(prefix: string): string {
		const repoRoot = mkdtempSync(join(tmpdir(), prefix));
		repoRoots.push(repoRoot);
		execSync("git init -b main", {
			cwd: repoRoot,
			stdio: "ignore",
		});
		return repoRoot;
	}

	it("returns relevant durable memories for multi-word prompts", () => {
		addMemory("api-design", "Use cursor pagination for REST list endpoints.", {
			tags: ["rest", "pagination"],
		});
		addMemory("frontend", "Prefer CSS variables for theming.", {
			tags: ["css"],
		});

		const addition = buildRelevantMemoryPromptAddition(
			"Update the REST list endpoints to use cursor pagination",
		);

		expect(addition).toContain("Automatic memory recall:");
		expect(addition).toContain("api-design");
		expect(addition).toContain("cursor pagination");
		expect(addition).not.toContain("CSS variables");
	});

	it("prioritizes current-session session memory and excludes other sessions", () => {
		upsertScopedMemory(
			"session-memory",
			"# Session Memory\nKeep the retry backoff logic intact.",
			{ sessionId: "sess-current" },
		);
		upsertScopedMemory(
			"session-memory",
			"# Session Memory\nOld unrelated migration note.",
			{ sessionId: "sess-other" },
		);

		const addition = buildRelevantMemoryPromptAddition(
			"Preserve the retry backoff logic in this change",
			{ sessionId: "sess-current" },
		);

		expect(addition).toContain("current session");
		expect(addition).toContain("retry backoff logic");
		expect(addition).not.toContain("Old unrelated migration note");
	});

	it("skips recall for low-context prompts", () => {
		addMemory("api-design", "Use cursor pagination for REST list endpoints.");

		expect(buildRelevantMemoryPromptAddition("pagination")).toBeNull();
	});

	it("prioritizes same-repo memories and excludes other repos", () => {
		const repoA = createGitRepo("maestro-recall-repo-a-");
		const repoB = createGitRepo("maestro-recall-repo-b-");

		addMemory("workflow", "Repo A uses blue-green deploys for production.", {
			cwd: repoA,
		});
		addMemory("workflow", "Repo B uses canary deploys for production.", {
			cwd: repoB,
		});

		const addition = buildRelevantMemoryPromptAddition(
			"Update the production deploy workflow to keep blue-green deploys intact",
			{
				cwd: repoA,
			},
		);

		expect(addition).toContain("current repo");
		expect(addition).toContain("blue-green deploys");
		expect(addition).not.toContain("canary deploys");
		expect(getMemoryProjectScope(repoA)?.projectId).not.toBe(
			getMemoryProjectScope(repoB)?.projectId,
		);
	});

	it("merges local session memory with remote durable recall", async () => {
		const repoRoot = createGitRepo("maestro-recall-remote-");
		upsertScopedMemory(
			"session-memory",
			"# Session Memory\nKeep the retry backoff logic intact.",
			{ sessionId: "sess-current", cwd: repoRoot },
		);
		process.env.MAESTRO_MEMORY_BASE = "https://memory.test";
		process.env.MAESTRO_MEMORY_ACCESS_TOKEN = "memory-token";
		process.env.MAESTRO_EVALOPS_ORG_ID = "org_123";

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/v1/memories/recall")) {
				return new Response(
					JSON.stringify({
						query: "Keep the retry backoff logic and preserve focused PRs",
						total: 1,
						memories: [
							{
								id: "mem_remote_1",
								organization_id: "org_123",
								type: "project",
								content:
									"Keep pull requests focused and land them with green CI.",
								repository: getMemoryProjectScope(repoRoot)?.projectId,
								agent: "maestro",
								score: 0.82,
								tags: [
									"auto",
									"durable",
									"workflow",
									"source:maestro",
									"maestro-kind:durable-memory",
									"maestro-topic:team-preferences",
								],
								created_at: "2026-04-09T00:00:00.000Z",
								updated_at: "2026-04-09T00:10:00.000Z",
							},
						],
					}),
					{ status: 200 },
				);
			}
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const addition = await buildRelevantMemoryPromptAdditionAsync(
			"Keep the retry backoff logic and preserve focused PRs",
			{
				sessionId: "sess-current",
				cwd: repoRoot,
			},
		);

		expect(addition).toContain("current session");
		expect(addition).toContain("retry backoff logic");
		expect(addition).toContain("team-preferences");
		expect(addition).toContain("green CI");
	});
});
