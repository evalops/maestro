import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { WebServerContext } from "../../src/server/app-context.js";
import { createRequestHandler } from "../../src/server/router.js";
import { createRoutes } from "../../src/server/routes.js";
import {
	IntelligentRouterService,
	setIntelligentRouterServiceForTest,
} from "../../src/services/intelligent-router/index.js";
import type { RoutingModelCandidate } from "../../src/services/intelligent-router/types.js";

const ROUTING_MODELS: RoutingModelCandidate[] = [
	{
		provider: "openai",
		model: "gpt-4o-mini",
		name: "GPT-4o mini",
		cost: { input: 0.15, output: 0.6 },
	},
	{
		provider: "anthropic",
		model: "claude-sonnet",
		name: "Claude Sonnet",
		cost: { input: 3, output: 15 },
	},
];

interface TestServer {
	baseUrl: string;
	close: () => Promise<void>;
}

async function failUnused<T>(): Promise<T> {
	throw new Error("Unexpected test server dependency call");
}

function createContext(): WebServerContext {
	return {
		corsHeaders: { "Access-Control-Allow-Origin": "*" },
		staticMaxAge: 0,
		defaultApprovalMode: "default",
		defaultProvider: "openai",
		defaultModelId: "gpt-4o-mini",
		createAgent: () => failUnused(),
		createBackgroundAgent: () => failUnused(),
		getRegisteredModel: () => failUnused(),
		getCurrentSelection: () => ({
			provider: "openai",
			modelId: "gpt-4o-mini",
		}),
		ensureCredential: () => failUnused(),
		setModelSelection: () => {},
		acquireSse: () => null,
		releaseSse: () => {},
		headlessRuntimeService: {} as WebServerContext["headlessRuntimeService"],
	};
}

async function startRouterServer(
	service: IntelligentRouterService,
): Promise<TestServer> {
	setIntelligentRouterServiceForTest(service);
	const context = createContext();
	const requestHandler = createRequestHandler(
		createRoutes(context),
		(_req, res) => {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Not found" }));
		},
		context.corsHeaders,
	);
	const server = createServer(async (req, res) => {
		const url = new URL(
			req.url ?? "/",
			`http://${req.headers.host ?? "localhost"}`,
		);
		await requestHandler(req, res, url.pathname);
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		close: () => closeServer(server),
	};
}

async function closeServer(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}

async function requestJson<T>(
	baseUrl: string,
	path: string,
	init?: RequestInit,
): Promise<{ status: number; body: T }> {
	const response = await fetch(`${baseUrl}${path}`, {
		...init,
		headers: {
			"Content-Type": "application/json",
			...(init?.headers ?? {}),
		},
	});
	return {
		status: response.status,
		body: (await response.json()) as T,
	};
}

function createService(): IntelligentRouterService {
	return new IntelligentRouterService(
		() => ROUTING_MODELS,
		() => new Date("2026-04-20T12:00:00.000Z"),
	);
}

async function postMetric(
	baseUrl: string,
	body: Record<string, unknown>,
): Promise<void> {
	const response = await requestJson<{ metric: { samples: number } }>(
		baseUrl,
		"/api/intelligent-router/metrics",
		{
			method: "POST",
			body: JSON.stringify(body),
		},
	);
	expect(response.status).toBe(201);
}

describe("intelligent router E2E", () => {
	afterEach(() => {
		setIntelligentRouterServiceForTest(null);
	});

	it("records production metrics and routes with fallback data over HTTP", async () => {
		const server = await startRouterServer(createService());
		try {
			await postMetric(server.baseUrl, {
				taskType: "coding",
				provider: "openai",
				model: "gpt-4o-mini",
				latencyMs: 800,
				success: true,
				costUsd: 0.001,
				qualityScore: 0.8,
			});
			await postMetric(server.baseUrl, {
				taskType: "coding",
				provider: "openai",
				model: "gpt-4o-mini",
				latencyMs: 900,
				success: true,
				costUsd: 0.0012,
				qualityScore: 0.82,
			});
			await postMetric(server.baseUrl, {
				taskType: "coding",
				provider: "anthropic",
				model: "claude-sonnet",
				latencyMs: 4000,
				success: false,
				costUsd: 0.02,
				qualityScore: 0.95,
			});
			await postMetric(server.baseUrl, {
				taskType: "coding",
				provider: "anthropic",
				model: "claude-sonnet",
				latencyMs: 4200,
				success: true,
				costUsd: 0.02,
				qualityScore: 0.95,
			});

			const metrics = await requestJson<{
				metrics: Array<{
					provider: string;
					model: string;
					samples: number;
					successRate: number;
				}>;
			}>(server.baseUrl, "/api/intelligent-router/metrics?task_type=coding");
			expect(metrics.status).toBe(200);
			expect(metrics.body.metrics).toEqual([
				expect.objectContaining({
					provider: "anthropic",
					model: "claude-sonnet",
					samples: 2,
					successRate: 0.5,
				}),
				expect.objectContaining({
					provider: "openai",
					model: "gpt-4o-mini",
					samples: 2,
					successRate: 1,
				}),
			]);

			const decision = await requestJson<{
				decision: {
					reason: string;
					selectedModel: { provider: string; model: string };
					fallbackChain: Array<{ provider: string; model: string }>;
					scores: Array<{
						provider: string;
						model: string;
						available: boolean;
						reasons: string[];
					}>;
				};
			}>(server.baseUrl, "/api/intelligent-router/decisions", {
				method: "POST",
				body: JSON.stringify({
					taskType: "coding",
					strategy: "balanced",
					availableModels: ROUTING_MODELS,
				}),
			});
			expect(decision.status).toBe(200);
			expect(decision.body.decision).toMatchObject({
				reason: "highest_score",
				selectedModel: { provider: "openai", model: "gpt-4o-mini" },
				fallbackChain: [{ provider: "anthropic", model: "claude-sonnet" }],
			});

			const failover = await requestJson<typeof decision.body>(
				server.baseUrl,
				"/api/intelligent-router/decisions",
				{
					method: "POST",
					body: JSON.stringify({
						taskType: "coding",
						strategy: "balanced",
						availableModels: ROUTING_MODELS,
						unavailableModels: ["openai/gpt-4o-mini"],
					}),
				},
			);
			expect(failover.status).toBe(200);
			expect(failover.body.decision.selectedModel).toEqual({
				provider: "anthropic",
				model: "claude-sonnet",
			});
			expect(
				failover.body.decision.scores.find(
					(score) => score.provider === "openai",
				),
			).toMatchObject({
				available: false,
				reasons: expect.arrayContaining(["unavailable"]),
			});
		} finally {
			await server.close();
		}
	});

	it("applies and removes model overrides through the public API", async () => {
		const server = await startRouterServer(createService());
		try {
			const override = await requestJson<{
				override: { taskType: string; provider: string; model: string };
			}>(server.baseUrl, "/api/intelligent-router/overrides", {
				method: "POST",
				body: JSON.stringify({
					taskType: "incident_response",
					provider: "anthropic",
					model: "claude-sonnet",
					reason: "Use stronger model during incident review",
				}),
			});
			expect(override.status).toBe(201);
			expect(override.body.override).toMatchObject({
				taskType: "incident_response",
				provider: "anthropic",
				model: "claude-sonnet",
			});

			const list = await requestJson<{
				overrides: Array<{ taskType: string; reason?: string }>;
			}>(server.baseUrl, "/api/intelligent-router/overrides");
			expect(list.status).toBe(200);
			expect(list.body.overrides).toEqual([
				expect.objectContaining({
					taskType: "incident_response",
					reason: "Use stronger model during incident review",
				}),
			]);

			const overriddenDecision = await requestJson<{
				decision: {
					reason: string;
					overrideApplied: boolean;
					selectedModel: { provider: string; model: string };
				};
			}>(server.baseUrl, "/api/intelligent-router/decisions", {
				method: "POST",
				body: JSON.stringify({
					taskType: "incident_response",
					modelHint: "openai/gpt-4o-mini",
					availableModels: ROUTING_MODELS,
				}),
			});
			expect(overriddenDecision.status).toBe(200);
			expect(overriddenDecision.body.decision).toMatchObject({
				reason: "override",
				overrideApplied: true,
				selectedModel: { provider: "anthropic", model: "claude-sonnet" },
			});

			const deleted = await requestJson<{ deleted: boolean; taskType: string }>(
				server.baseUrl,
				"/api/intelligent-router/overrides/incident_response",
				{ method: "DELETE" },
			);
			expect(deleted.status).toBe(200);
			expect(deleted.body).toEqual({
				deleted: true,
				taskType: "incident_response",
			});

			const hintDecision = await requestJson<typeof overriddenDecision.body>(
				server.baseUrl,
				"/api/intelligent-router/decisions",
				{
					method: "POST",
					body: JSON.stringify({
						taskType: "incident_response",
						modelHint: "openai/gpt-4o-mini",
						availableModels: ROUTING_MODELS,
					}),
				},
			);
			expect(hintDecision.status).toBe(200);
			expect(hintDecision.body.decision).toMatchObject({
				reason: "insufficient_history_model_hint",
				overrideApplied: false,
				selectedModel: { provider: "openai", model: "gpt-4o-mini" },
			});
		} finally {
			await server.close();
		}
	});

	it("returns validation errors for invalid metric and routing requests", async () => {
		const server = await startRouterServer(createService());
		try {
			const invalidMetric = await requestJson<{ error: string }>(
				server.baseUrl,
				"/api/intelligent-router/metrics",
				{
					method: "POST",
					body: JSON.stringify({
						taskType: "coding",
						provider: "openai",
						model: "gpt-4o-mini",
						latencyMs: -1,
					}),
				},
			);
			expect(invalidMetric.status).toBe(400);
			expect(invalidMetric.body).toEqual({
				error: "latencyMs cannot be negative.",
			});

			const allUnavailable = await requestJson<{ error: string }>(
				server.baseUrl,
				"/api/intelligent-router/decisions",
				{
					method: "POST",
					body: JSON.stringify({
						taskType: "coding",
						availableModels: ROUTING_MODELS,
						unavailableModels: [
							"openai/gpt-4o-mini",
							"anthropic/claude-sonnet",
						],
					}),
				},
			);
			expect(allUnavailable.status).toBe(400);
			expect(allUnavailable.body).toEqual({
				error: "All models are marked unavailable.",
			});
		} finally {
			await server.close();
		}
	});
});
