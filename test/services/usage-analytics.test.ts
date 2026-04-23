import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "../../src/agent/types.js";
import { handleUsageAnalytics } from "../../src/server/handlers/usage-analytics.js";
import {
	type UsageAnalyticsService,
	UsageAnalyticsUnavailableError,
	UsageAnalyticsValidationError,
	createUsageAnalyticsReport,
	normalizeUsageMetricInput,
	parseUsageAnalyticsPeriod,
	recordAssistantUsageMetric,
	resetUsageAnalyticsRecorderForTest,
	resolveUsageAgentId,
	resolveUsageWorkspaceId,
	setUsageAnalyticsServiceForTest,
} from "../../src/services/usage-analytics/index.js";
import type { UsageAnalyticsReport } from "../../src/services/usage-analytics/types.js";

interface MockRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
}

interface MockResponse {
	writableEnded: boolean;
	headersSent: boolean;
	statusCode?: number;
	body?: string;
	writeHead: ReturnType<typeof vi.fn>;
	end: ReturnType<typeof vi.fn>;
}

function createRequest(
	url: string,
	headers: Record<string, string> = {},
): MockRequest {
	return {
		method: "GET",
		url,
		headers,
	};
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

function createAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Done" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4",
		usage: {
			input: 100,
			output: 50,
			cacheRead: 10,
			cacheWrite: 5,
			cost: {
				input: 0.001,
				output: 0.002,
				cacheRead: 0.0001,
				cacheWrite: 0.0002,
				total: 0.0033,
			},
		},
		stopReason: "stop",
		timestamp: Date.parse("2026-04-20T12:00:00.000Z"),
	};
}

function waitForUsageRecorder(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("usage analytics", () => {
	afterEach(() => {
		setUsageAnalyticsServiceForTest(null);
		resetUsageAnalyticsRecorderForTest();
		vi.restoreAllMocks();
	});

	it("normalizes LLM usage into a daily aggregate bucket", () => {
		const metric = normalizeUsageMetricInput({
			workspaceId: " workspace-a ",
			agentId: " agent-1 ",
			sessionId: " session-1 ",
			provider: "anthropic",
			model: "claude-sonnet",
			inputTokens: 100.8,
			outputTokens: 50,
			cacheReadTokens: 20,
			cacheWriteTokens: 5,
			costUsd: 0.0123456,
			occurredAt: new Date("2026-04-20T12:34:56.000Z"),
		});

		expect(metric).toMatchObject({
			workspaceId: "workspace-a",
			agentId: "agent-1",
			sessionId: "session-1",
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 20,
			cacheWriteTokens: 5,
			totalTokens: 150,
			costUsdMicros: 12346,
		});
		expect(metric.bucketStart.toISOString()).toBe("2026-04-20T00:00:00.000Z");
	});

	it("rejects invalid aggregation periods", () => {
		expect(() => parseUsageAnalyticsPeriod("hourly")).toThrow(
			UsageAnalyticsValidationError,
		);
	});

	it("summarizes bucket totals for API responses", () => {
		const report = createUsageAnalyticsReport({
			period: "daily",
			filters: { workspaceId: "workspace-a" },
			buckets: [
				{
					bucketStart: "2026-04-20T00:00:00.000Z",
					workspaceId: "workspace-a",
					agentId: "agent-1",
					provider: "anthropic",
					model: "claude-sonnet",
					calls: 2,
					tokens: {
						input: 100,
						output: 50,
						cacheRead: 20,
						cacheWrite: 5,
						total: 175,
					},
					costUsd: 0.02,
				},
				{
					bucketStart: "2026-04-21T00:00:00.000Z",
					workspaceId: "workspace-a",
					agentId: "agent-2",
					provider: "openai",
					model: "gpt",
					calls: 1,
					tokens: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						total: 15,
					},
					costUsd: 0.01,
				},
			],
		});

		expect(report.totals).toEqual({
			calls: 3,
			tokens: {
				input: 110,
				output: 55,
				cacheRead: 20,
				cacheWrite: 5,
				total: 190,
			},
			costUsd: 0.03,
		});
	});

	it("resolves workspace and agent dimensions from request headers", () => {
		const req = createRequest("/api/chat", {
			"x-maestro-workspace-id": "workspace-from-header",
			"x-maestro-agent-id": "agent-from-header",
		}) as unknown as IncomingMessage;

		expect(resolveUsageWorkspaceId(req)).toBe("workspace-from-header");
		expect(
			resolveUsageAgentId({
				req,
				sessionId: "session-fallback",
				subject: "subject-fallback",
			}),
		).toBe("agent-from-header");
	});

	it("deduplicates repeated assistant usage metric emissions", async () => {
		const recordLlmCall = vi.fn().mockResolvedValue({ recorded: true });
		setUsageAnalyticsServiceForTest({
			queryUsage: vi.fn(),
			recordLlmCall,
		} as unknown as UsageAnalyticsService);
		const req = createRequest("/api/chat", {
			"x-maestro-workspace-id": "workspace-a",
			"x-maestro-agent-id": "agent-1",
		}) as unknown as IncomingMessage;
		const message = createAssistantMessage();

		recordAssistantUsageMetric({ req, message, sessionId: "session-1" });
		recordAssistantUsageMetric({ req, message, sessionId: "session-1" });

		await vi.waitFor(() => expect(recordLlmCall).toHaveBeenCalledTimes(1));
		expect(recordLlmCall).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceId: "workspace-a",
				agentId: "agent-1",
				sessionId: "session-1",
				inputTokens: 100,
				outputTokens: 50,
				costUsd: 0.0033,
			}),
		);
	});

	it("evicts assistant usage metric dedupe entries after failed writes", async () => {
		const recordLlmCall = vi
			.fn()
			.mockRejectedValueOnce(new Error("temporarily unavailable"))
			.mockResolvedValue({ recorded: true });
		setUsageAnalyticsServiceForTest({
			queryUsage: vi.fn(),
			recordLlmCall,
		} as unknown as UsageAnalyticsService);
		const req = createRequest("/api/chat", {
			"x-maestro-workspace-id": "workspace-a",
			"x-maestro-agent-id": "agent-1",
		}) as unknown as IncomingMessage;
		const message = createAssistantMessage();

		recordAssistantUsageMetric({ req, message, sessionId: "session-1" });
		await vi.waitFor(() => expect(recordLlmCall).toHaveBeenCalledTimes(1));
		await waitForUsageRecorder();

		recordAssistantUsageMetric({ req, message, sessionId: "session-1" });

		await vi.waitFor(() => expect(recordLlmCall).toHaveBeenCalledTimes(2));
	});

	it("queries database-backed usage analytics from the REST handler", async () => {
		const report: UsageAnalyticsReport = createUsageAnalyticsReport({
			period: "weekly",
			filters: { workspaceId: "workspace-a" },
			buckets: [],
		});
		const queryUsage = vi.fn().mockResolvedValue(report);
		setUsageAnalyticsServiceForTest({
			queryUsage,
			recordLlmCall: vi.fn(),
		} as unknown as UsageAnalyticsService);

		const req = createRequest(
			"/api/usage/analytics/weekly?workspaceId=workspace-a&from=2026-04-01",
		);
		const res = createResponse();

		await handleUsageAnalytics(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			{},
			{ period: "weekly" },
		);

		expect(queryUsage).toHaveBeenCalledWith(
			expect.objectContaining({
				period: "weekly",
				workspaceId: "workspace-a",
				from: new Date("2026-04-01"),
			}),
		);
		expect(res.statusCode).toBe(200);
		expect(parseJsonResponse(res)).toEqual({ analytics: report });
	});

	it("returns unavailable when usage analytics storage is not configured", async () => {
		setUsageAnalyticsServiceForTest({
			queryUsage: vi
				.fn()
				.mockRejectedValue(new UsageAnalyticsUnavailableError()),
			recordLlmCall: vi.fn(),
		} as unknown as UsageAnalyticsService);

		const req = createRequest("/api/usage/analytics?period=daily");
		const res = createResponse();

		await handleUsageAnalytics(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			{},
		);

		expect(res.statusCode).toBe(503);
		expect(parseJsonResponse(res)).toEqual({
			error: "Usage analytics database is not configured.",
		});
	});
});
