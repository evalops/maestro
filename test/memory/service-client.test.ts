import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
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
		Reflect.deleteProperty(process.env, "MAESTRO_MEMORY_AGENT_ID");
		Reflect.deleteProperty(process.env, "MAESTRO_EVALOPS_ORG_ID");
		Reflect.deleteProperty(process.env, "MAESTRO_MEMORY_TEAM_ID");
		Reflect.deleteProperty(
			process.env,
			"MAESTRO_MEMORY_IDENTITY_SERVICE_TOKENS_URL",
		);
		Reflect.deleteProperty(
			process.env,
			"MAESTRO_MEMORY_IDENTITY_BOOTSTRAP_KEY",
		);
		Reflect.deleteProperty(
			process.env,
			"MAESTRO_MEMORY_SERVICE_TOKEN_TTL_SECONDS",
		);
		vi.doUnmock("node:https");
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
		expect(requests[0]?.url).toContain("agent_id=maestro");
		expect(requests[0]?.url).toContain("review_status=approved");
		expect(requests[1]?.method).toBe("POST");
		const createBody = JSON.parse(String(requests[1]?.body));
		expect(createBody.repository).toBeTruthy();
		expect(createBody.agent).toBe("maestro");
		expect(createBody.agent_id).toBe("maestro");
		expect(createBody.review_status).toBe("approved");
		expect(createBody.source_references).toEqual([
			expect.objectContaining({
				type: "maestro-durable-memory",
				metadata: expect.objectContaining({
					source: "maestro",
					topic: "team-preferences",
				}),
			}),
		]);
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

	it("attaches session provenance to remote durable memories", async () => {
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
							id: "mem_remote_session",
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
		await upsertRemoteDurableMemory(
			"team-preferences",
			"Keep pull requests focused.",
			{
				cwd: repoRoot,
				sessionId: "session-123",
				tags: ["auto", "durable", "workflow"],
			},
		);

		const createBody = JSON.parse(String(requests[1]?.body));
		expect(createBody.tags).toEqual(
			expect.arrayContaining(["maestro-session:session-123"]),
		);
		expect(createBody.source_references).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "maestro-session",
					uri: "maestro://sessions/session-123",
					metadata: expect.objectContaining({
						sessionId: "session-123",
						source: "maestro",
					}),
				}),
			]),
		);
	});

	it("updates matching remote durable memories when metadata changes", async () => {
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
		const updateBody = JSON.parse(String(requests[1]?.body));
		expect(updateBody.review_status).toBe("approved");
		expect(updateBody.source_references).toEqual([
			expect.objectContaining({
				type: "maestro-durable-memory",
				metadata: expect.objectContaining({
					projectId: "repo_123",
					projectName: "maestro",
					source: "maestro",
					topic: "team-preferences",
				}),
			}),
		]);
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
		const requests: Array<{ body?: string; method?: string; url: string }> = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				requests.push({
					url,
					method: init?.method,
					body: typeof init?.body === "string" ? init.body : undefined,
				});
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
		const recallBody = JSON.parse(String(requests[0]?.body));
		expect(recallBody.agent_id).toBe("maestro");
		expect(recallBody.review_status).toBe("approved");
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

	it("uses configured memory token before identity-issued service tokens", async () => {
		process.env.MAESTRO_MEMORY_IDENTITY_SERVICE_TOKENS_URL =
			"https://identity.test/identity.v1.TokenService/IssueServiceToken";
		process.env.MAESTRO_MEMORY_IDENTITY_BOOTSTRAP_KEY = "bootstrap-key";

		const httpsRequest = vi.fn(() => {
			throw new Error("identity token request should not be used");
		});
		vi.doMock("node:https", () => ({
			request: httpsRequest,
		}));

		const authorizations: string[] = [];
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				const headers = new Headers(init?.headers);
				authorizations.push(headers.get("Authorization") ?? "");
				return new Response(JSON.stringify({ memories: [], total: 0 }), {
					status: 200,
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		const { recallRemoteDurableMemories } = await import(
			"../../src/memory/service-client.js"
		);
		await recallRemoteDurableMemories("focused prs", { limit: 1 });

		expect(httpsRequest).not.toHaveBeenCalled();
		expect(authorizations).toEqual(["Bearer memory-token"]);
	});

	it("requests and caches identity-issued memory service tokens before OAuth fallback", async () => {
		Reflect.deleteProperty(process.env, "MAESTRO_MEMORY_ACCESS_TOKEN");
		process.env.MAESTRO_MEMORY_IDENTITY_SERVICE_TOKENS_URL =
			"https://identity.test/identity.v1.TokenService/IssueServiceToken";
		process.env.MAESTRO_MEMORY_IDENTITY_BOOTSTRAP_KEY = "bootstrap-key";
		process.env.MAESTRO_MEMORY_SERVICE_TOKEN_TTL_SECONDS = "123";
		const issuedMemoryToken = ["identity", "memory", "token"].join("-");

		const tokenRequests: Array<{
			body: string;
			headers: Record<string, string>;
			url: string;
		}> = [];
		const httpsRequest = vi.fn(
			(
				url: URL,
				options: {
					headers?: Record<string, string>;
					method?: string;
				},
				callback: (response: PassThrough & { statusCode?: number }) => void,
			) => {
				let body = "";
				const request = new EventEmitter() as EventEmitter & {
					end: () => void;
					write: (chunk: string) => void;
				};
				request.write = (chunk: string) => {
					body += chunk;
				};
				request.end = () => {
					tokenRequests.push({
						body,
						headers: options.headers ?? {},
						url: url.toString(),
					});
					const response = new PassThrough() as PassThrough & {
						statusCode?: number;
					};
					response.statusCode = 201;
					callback(response);
					response.end(
						JSON.stringify({
							token: issuedMemoryToken,
							expires_at: "2099-01-01T00:00:00.000Z",
						}),
					);
				};
				return request;
			},
		);
		vi.doMock("node:https", () => ({
			request: httpsRequest,
		}));

		const authorizations: string[] = [];
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				const headers = new Headers(init?.headers);
				authorizations.push(headers.get("Authorization") ?? "");
				return new Response(JSON.stringify({ memories: [], total: 0 }), {
					status: 200,
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		const {
			recallRemoteDurableMemories,
			resetMemoryServiceTokenCacheForTests,
		} = await import("../../src/memory/service-client.js");
		resetMemoryServiceTokenCacheForTests();
		await recallRemoteDurableMemories("focused prs", { limit: 1 });
		await recallRemoteDurableMemories("focused prs", { limit: 1 });

		expect(httpsRequest).toHaveBeenCalledTimes(1);
		expect(tokenRequests).toEqual([
			expect.objectContaining({
				url: "https://identity.test/identity.v1.TokenService/IssueServiceToken",
				headers: expect.objectContaining({
					"Connect-Protocol-Version": "1",
					"Content-Type": "application/json",
					"X-Identity-Bootstrap-Key": "bootstrap-key",
				}),
			}),
		]);
		expect(JSON.parse(tokenRequests[0]?.body ?? "{}")).toEqual({
			service: "maestro",
			organization_id: "org_123",
			scopes: ["memories:read", "memories:write"],
			ttl_seconds: 123,
		});
		expect(authorizations).toEqual([
			`Bearer ${issuedMemoryToken}`,
			`Bearer ${issuedMemoryToken}`,
		]);
	});

	it("keys cached identity-issued memory service tokens by organization", async () => {
		Reflect.deleteProperty(process.env, "MAESTRO_MEMORY_ACCESS_TOKEN");
		process.env.MAESTRO_MEMORY_IDENTITY_SERVICE_TOKENS_URL =
			"https://identity.test/identity.v1.TokenService/IssueServiceToken";
		process.env.MAESTRO_MEMORY_IDENTITY_BOOTSTRAP_KEY = "bootstrap-key";

		const tokenRequests: Array<{ organizationId: string }> = [];
		const httpsRequest = vi.fn(
			(
				_url: URL,
				_options: {
					headers?: Record<string, string>;
					method?: string;
				},
				callback: (response: PassThrough & { statusCode?: number }) => void,
			) => {
				let body = "";
				const request = new EventEmitter() as EventEmitter & {
					end: () => void;
					write: (chunk: string) => void;
				};
				request.write = (chunk: string) => {
					body += chunk;
				};
				request.end = () => {
					const parsed = JSON.parse(body) as { organization_id: string };
					tokenRequests.push({ organizationId: parsed.organization_id });
					const response = new PassThrough() as PassThrough & {
						statusCode?: number;
					};
					response.statusCode = 201;
					callback(response);
					response.end(
						JSON.stringify({
							token: `identity-token-${parsed.organization_id}`,
							expires_at: "2099-01-01T00:00:00.000Z",
						}),
					);
				};
				return request;
			},
		);
		vi.doMock("node:https", () => ({
			request: httpsRequest,
		}));

		const authorizations: string[] = [];
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				const headers = new Headers(init?.headers);
				authorizations.push(headers.get("Authorization") ?? "");
				return new Response(JSON.stringify({ memories: [], total: 0 }), {
					status: 200,
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		const {
			recallRemoteDurableMemories,
			resetMemoryServiceTokenCacheForTests,
		} = await import("../../src/memory/service-client.js");
		resetMemoryServiceTokenCacheForTests();

		process.env.MAESTRO_EVALOPS_ORG_ID = "org_alpha";
		await recallRemoteDurableMemories("focused prs", { limit: 1 });
		process.env.MAESTRO_EVALOPS_ORG_ID = "org_beta";
		await recallRemoteDurableMemories("focused prs", { limit: 1 });
		process.env.MAESTRO_EVALOPS_ORG_ID = "org_alpha";
		await recallRemoteDurableMemories("focused prs", { limit: 1 });

		expect(tokenRequests).toEqual([
			{ organizationId: "org_alpha" },
			{ organizationId: "org_beta" },
		]);
		expect(authorizations).toEqual([
			"Bearer identity-token-org_alpha",
			"Bearer identity-token-org_beta",
			"Bearer identity-token-org_alpha",
		]);
	});
});
