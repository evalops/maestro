import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getMemoryProjectScope,
	upsertScopedMemory,
} from "../../src/memory/index.js";
import { getDurableMemoryBackend } from "../../src/memory/backend.js";
import { buildRelevantMemoryPromptAdditionAsync } from "../../src/memory/relevant-recall.js";
import { createEvalResult, printEvalSuiteReport } from "./shared";

interface MemoryBackendEvalCase {
	name: string;
	run: () => Promise<unknown>;
	expected: unknown;
}

function createGitRepo(prefix: string): string {
	const repoRoot = mkdtempSync(join(tmpdir(), prefix));
	execSync("git init -b main", {
		cwd: repoRoot,
		stdio: "ignore",
	});
	return repoRoot;
}

function withEnv(env: Record<string, string>, run: () => Promise<unknown>) {
	return async () => {
		const originalValues = new Map<string, string | undefined>();
		for (const [key, value] of Object.entries(env)) {
			originalValues.set(key, process.env[key]);
			process.env[key] = value;
		}

		try {
			return await run();
		} finally {
			for (const [key, value] of originalValues.entries()) {
				if (value === undefined) {
					Reflect.deleteProperty(process.env, key);
				} else {
					process.env[key] = value;
				}
			}
		}
	};
}

function withFetchStub<T>(
	fetchImpl: typeof fetch,
	run: () => Promise<T>,
): Promise<T> {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = fetchImpl;
	return run().finally(() => {
		globalThis.fetch = originalFetch;
	});
}

const cases: MemoryBackendEvalCase[] = [];
const cleanupPaths: string[] = [];

{
	const repoRoot = createGitRepo("maestro-memory-backend-eval-upsert-");
	const maestroHome = mkdtempSync(join(tmpdir(), "maestro-memory-home-"));
	const scope = getMemoryProjectScope(repoRoot);
	cleanupPaths.push(repoRoot, maestroHome);

	cases.push({
		name: "remote durable memory upsert preserves scope and tags",
		expected: {
			created: true,
			updated: false,
			requestRepository: scope?.projectId,
			tagChecks: {
				hasAuto: true,
				hasDurable: true,
				hasWorkflow: true,
				hasSource: true,
				hasManagedKind: true,
				hasTopic: true,
				hasProjectName: true,
			},
			entry: {
				topic: "team-preferences",
				projectId: scope?.projectId,
				projectName: scope?.projectName,
			},
		},
		run: withEnv(
			{
				MAESTRO_HOME: maestroHome,
				MAESTRO_MEMORY_BASE: "https://memory.test",
				MAESTRO_MEMORY_ACCESS_TOKEN: "memory-token",
				MAESTRO_EVALOPS_ORG_ID: "org_123",
			},
			async () => {
				let createRequestBody: Record<string, unknown> | null = null;
				return withFetchStub(
					async (input: RequestInfo | URL, init?: RequestInit) => {
						const url = typeof input === "string" ? input : input.toString();
						if (url.includes("/v1/memories?")) {
							return new Response(JSON.stringify({ memories: [] }), {
								status: 200,
							});
						}
						if (url.endsWith("/v1/memories")) {
							const body = JSON.parse(String(init?.body));
							createRequestBody = body as Record<string, unknown>;
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
					async () => {
						const backend = getDurableMemoryBackend();
						const result = await backend.upsertDurableMemory(
							"team-preferences",
							"Keep PRs focused.",
							{
								cwd: repoRoot,
								tags: ["auto", "durable", "workflow"],
							},
						);

						return {
							created: result?.created ?? false,
							updated: result?.updated ?? false,
							requestRepository: createRequestBody?.repository,
							tagChecks: {
								hasAuto:
									(Array.isArray(createRequestBody?.tags)
										? createRequestBody.tags
										: []
									).includes("auto"),
								hasDurable:
									(Array.isArray(createRequestBody?.tags)
										? createRequestBody.tags
										: []
									).includes("durable"),
								hasWorkflow:
									(Array.isArray(createRequestBody?.tags)
										? createRequestBody.tags
										: []
									).includes("workflow"),
								hasSource:
									(Array.isArray(createRequestBody?.tags)
										? createRequestBody.tags
										: []
									).includes("source:maestro"),
								hasManagedKind:
									(Array.isArray(createRequestBody?.tags)
										? createRequestBody.tags
										: []
									).includes("maestro-kind:durable-memory"),
								hasTopic:
									(Array.isArray(createRequestBody?.tags)
										? createRequestBody.tags
										: []
									).includes("maestro-topic:team-preferences"),
								hasProjectName:
									(Array.isArray(createRequestBody?.tags)
										? createRequestBody.tags
										: []
									).some((tag) =>
										typeof tag === "string" &&
										tag.startsWith("maestro-project-name:"),
									),
							},
							entry: result?.entry,
						};
					},
				);
			},
		),
	});
}

{
	const repoRoot = createGitRepo("maestro-memory-backend-eval-recall-");
	const maestroHome = mkdtempSync(join(tmpdir(), "maestro-memory-home-"));
	const scope = getMemoryProjectScope(repoRoot);
	cleanupPaths.push(repoRoot, maestroHome);

	cases.push({
		name: "relevant recall merges remote durable memories with session memory",
		expected: {
			hasCurrentSession: true,
			hasRemoteTopic: true,
			hasRemoteContent: true,
		},
		run: withEnv(
			{
				MAESTRO_HOME: maestroHome,
				MAESTRO_MEMORY_BASE: "https://memory.test",
				MAESTRO_MEMORY_ACCESS_TOKEN: "memory-token",
				MAESTRO_EVALOPS_ORG_ID: "org_123",
			},
			async () => {
				upsertScopedMemory(
					"session-memory",
					"# Session Memory\nKeep the retry backoff logic intact.",
					{ sessionId: "sess-current", cwd: repoRoot },
				);

				return withFetchStub(
					async (input: RequestInfo | URL) => {
						const url = typeof input === "string" ? input : input.toString();
						if (url.endsWith("/v1/memories/recall")) {
							return new Response(
								JSON.stringify({
									query: "Keep the retry backoff logic and preserve focused PRs",
									total: 1,
									memories: [
										{
											id: "mem_remote_2",
											organization_id: "org_123",
											type: "project",
											content:
												"Keep pull requests focused and land them with green CI.",
											repository: scope?.projectId,
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
					},
					async () => {
						const addition = await buildRelevantMemoryPromptAdditionAsync(
							"Keep the retry backoff logic and preserve focused PRs",
							{
								sessionId: "sess-current",
								cwd: repoRoot,
							},
						);

						return {
							hasCurrentSession: addition?.includes("current session") ?? false,
							hasRemoteTopic: addition?.includes("team-preferences") ?? false,
							hasRemoteContent: addition?.includes("green CI") ?? false,
						};
					},
				);
			},
		),
	});
}

const results = [];
for (const testCase of cases) {
	results.push(
		createEvalResult(testCase, await testCase.run(), testCase.expected),
	);
}
const summary = printEvalSuiteReport("memory-backend-evals", results);

if (summary.failed > 0) {
	process.exitCode = 1;
}

for (const path of cleanupPaths) {
	rmSync(path, { recursive: true, force: true });
}
