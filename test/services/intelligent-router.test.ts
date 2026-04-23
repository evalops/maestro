import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleIntelligentRouter } from "../../src/server/handlers/intelligent-router.js";
import {
	IntelligentRouterService,
	resolveIntelligentRouterStrategy,
	setIntelligentRouterServiceForTest,
} from "../../src/services/intelligent-router/index.js";
import type { RoutingModelCandidate } from "../../src/services/intelligent-router/types.js";

interface MockResponse {
	writableEnded: boolean;
	headersSent: boolean;
	statusCode?: number;
	body?: string;
	writeHead: ReturnType<typeof vi.fn>;
	end: ReturnType<typeof vi.fn>;
}

const MODELS: RoutingModelCandidate[] = [
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

function createRequest(
	method: string,
	url: string,
	body?: unknown,
	headers: Record<string, string> = {},
): IncomingMessage {
	const payload =
		body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
	const req = Readable.from(payload) as IncomingMessage;
	req.method = method;
	req.url = url;
	req.headers = { host: "localhost", ...headers };
	return req;
}

function createResponse(): MockResponse {
	const res: MockResponse = {
		writableEnded: false,
		headersSent: false,
		writeHead: vi.fn((statusCode: number) => {
			res.statusCode = statusCode;
			res.headersSent = true;
		}),
		end: vi.fn((body?: string) => {
			res.body = body;
			res.writableEnded = true;
		}),
	};
	return res;
}

function parseJsonResponse(res: MockResponse): unknown {
	return JSON.parse(res.body ?? "{}");
}

function createService(): IntelligentRouterService {
	return new IntelligentRouterService(
		() => MODELS,
		() => new Date("2026-04-20T12:00:00.000Z"),
	);
}

describe("intelligent router service", () => {
	afterEach(() => {
		setIntelligentRouterServiceForTest(null);
		vi.restoreAllMocks();
	});

	it("preserves the model hint until enough production history exists", () => {
		const service = createService();

		const decision = service.routeRequest({
			taskType: "code_review",
			modelHint: "anthropic/claude-sonnet",
		});

		expect(decision.reason).toBe("insufficient_history_model_hint");
		expect(decision.selectedModel).toEqual({
			provider: "anthropic",
			model: "claude-sonnet",
		});
		expect(decision.fallbackChain).toEqual([
			{ provider: "openai", model: "gpt-4o-mini" },
		]);
	});

	it("preserves colon-delimited model hints until enough production history exists", () => {
		const service = createService();

		const decision = service.routeRequest({
			taskType: "code_review",
			modelHint: "anthropic:claude-sonnet",
		});

		expect(decision.reason).toBe("insufficient_history_model_hint");
		expect(decision.selectedModel).toEqual({
			provider: "anthropic",
			model: "claude-sonnet",
		});
		expect(decision.fallbackChain).toEqual([
			{ provider: "openai", model: "gpt-4o-mini" },
		]);
	});

	it("routes to the best scored model from latency, success, and cost metrics", () => {
		const service = createService();
		service.recordPerformanceMetric({
			taskType: "summarization",
			provider: "openai",
			model: "gpt-4o-mini",
			latencyMs: 800,
			success: true,
			costUsd: 0.001,
			qualityScore: 0.8,
		});
		service.recordPerformanceMetric({
			taskType: "summarization",
			provider: "openai",
			model: "gpt-4o-mini",
			latencyMs: 900,
			success: true,
			costUsd: 0.0012,
			qualityScore: 0.82,
		});
		service.recordPerformanceMetric({
			taskType: "summarization",
			provider: "anthropic",
			model: "claude-sonnet",
			latencyMs: 4000,
			success: false,
			costUsd: 0.02,
			qualityScore: 0.9,
		});
		service.recordPerformanceMetric({
			taskType: "summarization",
			provider: "anthropic",
			model: "claude-sonnet",
			latencyMs: 4200,
			success: true,
			costUsd: 0.02,
			qualityScore: 0.9,
		});

		const decision = service.routeRequest({
			taskType: "summarization",
			strategy: "balanced",
		});

		expect(decision.reason).toBe("highest_score");
		expect(decision.selectedModel).toEqual({
			provider: "openai",
			model: "gpt-4o-mini",
		});
		expect(decision.scores[0]).toMatchObject({
			provider: "openai",
			model: "gpt-4o-mini",
			samples: 2,
			successRate: 1,
		});
	});

	it("applies overrides and keeps an explicit fallback chain", () => {
		const service = createService();
		service.setOverride({
			taskType: "incident_response",
			provider: "anthropic",
			model: "claude-sonnet",
			reason: "Use stronger model for incident response",
		});

		const decision = service.routeRequest({
			taskType: "incident_response",
			modelHint: "openai/gpt-4o-mini",
		});

		expect(decision.overrideApplied).toBe(true);
		expect(decision.reason).toBe("override");
		expect(decision.selectedModel).toEqual({
			provider: "anthropic",
			model: "claude-sonnet",
		});
		expect(decision.fallbackChain).toEqual([
			{ provider: "openai", model: "gpt-4o-mini" },
		]);
	});

	it("ignores invalid routing strategy headers", () => {
		const req = createRequest("GET", "/api/intelligent-router", undefined, {
			"x-maestro-routing-strategy": "definitely-not-valid",
		});

		expect(resolveIntelligentRouterStrategy(req)).toBeUndefined();
	});
});

describe("intelligent router REST handler", () => {
	afterEach(() => {
		setIntelligentRouterServiceForTest(null);
		vi.restoreAllMocks();
	});

	it("records metrics and lists aggregated model performance", async () => {
		setIntelligentRouterServiceForTest(createService());
		const metricReq = createRequest("POST", "/api/intelligent-router/metrics", {
			taskType: "coding",
			provider: "openai",
			model: "gpt-4o-mini",
			latencyMs: 1200,
			success: true,
			costUsd: 0.002,
		});
		const metricRes = createResponse();

		await handleIntelligentRouter(
			metricReq,
			metricRes as unknown as ServerResponse,
			{},
		);

		expect(metricRes.statusCode).toBe(201);
		expect(parseJsonResponse(metricRes)).toMatchObject({
			metric: {
				taskType: "coding",
				provider: "openai",
				model: "gpt-4o-mini",
				samples: 1,
			},
		});

		const listReq = createRequest(
			"GET",
			"/api/intelligent-router/metrics?task_type=coding",
		);
		const listRes = createResponse();
		await handleIntelligentRouter(
			listReq,
			listRes as unknown as ServerResponse,
			{},
		);

		expect(listRes.statusCode).toBe(200);
		expect(parseJsonResponse(listRes)).toMatchObject({
			metrics: [{ taskType: "coding", samples: 1 }],
		});
	});

	it("rejects nested intelligent router resource paths", async () => {
		setIntelligentRouterServiceForTest(createService());
		const req = createRequest(
			"GET",
			"/api/intelligent-router/metrics/overrides",
		);
		const res = createResponse();

		await handleIntelligentRouter(req, res as unknown as ServerResponse, {});

		expect(res.statusCode).toBe(405);
		expect(parseJsonResponse(res)).toMatchObject({
			error: "Method not allowed",
		});
	});

	it("sets overrides and routes decisions through the override", async () => {
		setIntelligentRouterServiceForTest(createService());
		const overrideReq = createRequest(
			"POST",
			"/api/intelligent-router/overrides",
			{
				taskType: "coding",
				provider: "anthropic",
				model: "claude-sonnet",
				reason: "temporary override",
			},
		);
		const overrideRes = createResponse();

		await handleIntelligentRouter(
			overrideReq,
			overrideRes as unknown as ServerResponse,
			{},
		);

		expect(overrideRes.statusCode).toBe(201);
		expect(parseJsonResponse(overrideRes)).toMatchObject({
			override: {
				taskType: "coding",
				provider: "anthropic",
				model: "claude-sonnet",
			},
		});

		const decisionReq = createRequest(
			"POST",
			"/api/intelligent-router/decisions",
			{
				taskType: "coding",
				modelHint: "openai/gpt-4o-mini",
				availableModels: MODELS,
			},
		);
		const decisionRes = createResponse();
		await handleIntelligentRouter(
			decisionReq,
			decisionRes as unknown as ServerResponse,
			{},
		);

		expect(decisionRes.statusCode).toBe(200);
		expect(parseJsonResponse(decisionRes)).toMatchObject({
			decision: {
				overrideApplied: true,
				selectedModel: {
					provider: "anthropic",
					model: "claude-sonnet",
				},
			},
		});
	});
});
