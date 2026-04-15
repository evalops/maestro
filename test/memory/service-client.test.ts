import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("memory service client", () => {
	let repoRoot: string;

	beforeEach(() => {
		repoRoot = mkdtempSync(join(tmpdir(), "maestro-memory-service-repo-"));
		execSync("git init -b main", {
			cwd: repoRoot,
			stdio: "ignore",
		});
		process.env.MAESTRO_MEMORY_BASE = "https://memory.test";
		process.env.MAESTRO_MEMORY_ACCESS_TOKEN = "memory-token";
		process.env.MAESTRO_EVALOPS_ORG_ID = "org_123";
		vi.resetModules();
	});

	afterEach(() => {
		Reflect.deleteProperty(process.env, "MAESTRO_MEMORY_BASE");
		Reflect.deleteProperty(process.env, "MAESTRO_MEMORY_ACCESS_TOKEN");
		Reflect.deleteProperty(process.env, "MAESTRO_EVALOPS_ORG_ID");
		Reflect.deleteProperty(process.env, "MAESTRO_MEMORY_TEAM_ID");
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		rmSync(repoRoot, { recursive: true, force: true });
	});

	it("creates remote durable memories with Maestro metadata tags", async () => {
		const requests: Array<{ body?: string; method?: string; url: string }> = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				requests.push({
					url,
					method: init?.method,
					body: typeof init?.body === "string" ? init.body : undefined,
				});
				if (url.includes("/v1/memories?")) {
					return new Response(JSON.stringify({ memories: [] }), {
						status: 200,
					});
				}
				if (url.endsWith("/v1/memories")) {
					const body = JSON.parse(String(init?.body));
					return new Response(
						JSON.stringify({
							id: "mem_remote_1",
							organization_id: "org_123",
							type: "project",
							content: body.content,
							repository: body.repository,
							agent: body.agent,
							tags: body.tags,
							created_at: "2026-04-09T00:00:00.000Z",
							updated_at: "2026-04-09T00:00:00.000Z",
						}),
						{ status: 201 },
					);
				}
				throw new Error(`Unexpected request: ${url}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		const { upsertRemoteDurableMemory } = await import(
			"../../src/memory/service-client.js"
		);
		const result = await upsertRemoteDurableMemory(
			"team-preferences",
			"Keep pull requests focused.",
			{
				cwd: repoRoot,
				tags: ["auto", "durable", "workflow"],
			},
		);

		expect(requests[0]?.url).toContain("/v1/memories?");
		expect(requests[1]?.method).toBe("POST");
		const createBody = JSON.parse(String(requests[1]?.body));
		expect(createBody.repository).toBeTruthy();
		expect(createBody.agent).toBe("maestro");
		expect(createBody.tags).toEqual(
			expect.arrayContaining([
				"auto",
				"durable",
				"workflow",
				"source:maestro",
				"maestro-kind:durable-memory",
				"maestro-topic:team-preferences",
			]),
		);
		expect(result).toMatchObject({
			created: true,
			updated: false,
			entry: {
				topic: "team-preferences",
				projectId: expect.any(String),
				projectName: expect.any(String),
			},
		});
	});

	it("updates matching remote durable memories when metadata changes", async () => {
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				if (url.includes("/v1/memories?")) {
					return new Response(
						JSON.stringify({
							memories: [
								{
									id: "mem_remote_1",
									organization_id: "org_123",
									type: "project",
									content: "Keep pull requests focused.",
									repository: "repo_123",
									agent: "maestro",
									tags: [
										"auto",
										"durable",
										"source:maestro",
										"maestro-kind:durable-memory",
										"maestro-topic:team-preferences",
									],
									created_at: "2026-04-09T00:00:00.000Z",
									updated_at: "2026-04-09T00:00:00.000Z",
								},
							],
						}),
						{ status: 200 },
					);
				}
				if (url.endsWith("/v1/memories/mem_remote_1")) {
					const body = JSON.parse(String(init?.body));
					return new Response(
						JSON.stringify({
							id: "mem_remote_1",
							organization_id: "org_123",
							type: "project",
							content: body.content,
							repository: "repo_123",
							agent: "maestro",
							tags: body.tags,
							created_at: "2026-04-09T00:00:00.000Z",
							updated_at: "2026-04-09T00:05:00.000Z",
						}),
						{ status: 200 },
					);
				}
				throw new Error(`Unexpected request: ${url}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		const { upsertRemoteDurableMemory } = await import(
			"../../src/memory/service-client.js"
		);
		const result = await upsertRemoteDurableMemory(
			"team-preferences",
			"Keep pull requests focused.",
			{
				projectId: "repo_123",
				projectName: "maestro",
				tags: ["auto", "durable", "workflow"],
			},
		);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result).toMatchObject({
			created: false,
			updated: true,
			entry: {
				topic: "team-preferences",
				projectId: "repo_123",
				projectName: "maestro",
				tags: expect.arrayContaining(["auto", "durable", "workflow"]),
			},
		});
	});

	it("recalls remote durable memories for the current repository scope", async () => {
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				if (url.endsWith("/v1/memories/recall")) {
					const body = JSON.parse(String(init?.body));
					return new Response(
						JSON.stringify({
							query: body.query,
							total: 1,
							memories: [
								{
									id: "mem_remote_2",
									organization_id: "org_123",
									type: "project",
									content:
										"Keep pull requests focused and land them with green CI.",
									repository: body.repository,
									agent: "maestro",
									score: 0.73,
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
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		const { recallRemoteDurableMemories } = await import(
			"../../src/memory/service-client.js"
		);
		const results = await recallRemoteDurableMemories(
			"keep pull requests focused and green",
			{
				cwd: repoRoot,
				limit: 3,
			},
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(results).toEqual([
			expect.objectContaining({
				score: 0.73,
				entry: expect.objectContaining({
					topic: "team-preferences",
					content: "Keep pull requests focused and land them with green CI.",
					projectId: expect.any(String),
					projectName: expect.any(String),
				}),
			}),
		]);
	});
});
