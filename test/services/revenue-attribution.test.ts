import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRevenueAttribution } from "../../src/server/handlers/revenue-attribution.js";
import {
	type RevenueAttributionService,
	RevenueAttributionUnavailableError,
	RevenueAttributionValidationError,
	createRevenueAttributionRoiReport,
	normalizeRevenueOutcomeInput,
	setRevenueAttributionServiceForTest,
} from "../../src/services/revenue-attribution/index.js";

interface MockResponse {
	writableEnded: boolean;
	headersSent: boolean;
	statusCode?: number;
	body?: string;
	writeHead: ReturnType<typeof vi.fn>;
	end: ReturnType<typeof vi.fn>;
}

function createRequest(
	method: string,
	url: string,
	body?: unknown,
): IncomingMessage {
	const payload =
		body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
	const req = Readable.from(payload) as IncomingMessage;
	req.method = method;
	req.url = url;
	req.headers = { host: "localhost" };
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

describe("revenue attribution service", () => {
	afterEach(() => {
		setRevenueAttributionServiceForTest(null);
		vi.restoreAllMocks();
	});

	it("normalizes revenue outcomes into stored attribution values", () => {
		const outcome = normalizeRevenueOutcomeInput({
			workspaceId: " workspace-a ",
			agentId: " agent-1 ",
			actionId: " action-1 ",
			traceId: " trace-1 ",
			outcomeId: " deal-1 ",
			outcomeType: "Closed_Won",
			attributionModel: "assisted",
			attributionWeight: 0.25,
			revenueUsd: 100,
			pipelineValueUsd: 250,
			costUsd: 2.5,
			durationMs: 99.9,
			occurredAt: "2026-04-20T12:00:00.000Z",
			metadata: { stage: "closed_won", ignored: undefined },
		});

		expect(outcome).toMatchObject({
			workspaceId: "workspace-a",
			agentId: "agent-1",
			actionId: "action-1",
			traceId: "trace-1",
			outcomeId: "deal-1",
			outcomeType: "closed_won",
			attributionModel: "assisted",
			attributionWeightBps: 2500,
			revenueUsdMicros: 100_000_000,
			pipelineValueUsdMicros: 250_000_000,
			costUsdMicros: 2_500_000,
			durationMs: 99,
			metadata: { stage: "closed_won" },
		});
		expect(outcome.occurredAt.toISOString()).toBe("2026-04-20T12:00:00.000Z");
	});

	it("rejects invalid attribution weights", () => {
		expect(() =>
			normalizeRevenueOutcomeInput({
				workspaceId: "workspace-a",
				agentId: "agent-1",
				outcomeId: "deal-1",
				outcomeType: "closed_won",
				attributionWeight: 1.5,
			}),
		).toThrow(RevenueAttributionValidationError);
	});

	it("calculates ROI metrics from attributed revenue and cost totals", () => {
		const report = createRevenueAttributionRoiReport({
			query: {
				workspaceId: "workspace-a",
				agentId: "agent-1",
				from: new Date("2026-04-01T00:00:00.000Z"),
			},
			totalsRow: {
				outcome_count: "3",
				action_count: "2",
				trace_count: "1",
				revenue_usd_micros: "156000000000",
				pipeline_value_usd_micros: "487000000000",
				cost_usd_micros: "1847320000",
				duration_ms: "452100",
			},
			outcomeRows: [
				{
					outcome_type: "closed_won",
					outcome_count: "1",
					revenue_usd_micros: "156000000000",
					pipeline_value_usd_micros: "156000000000",
					cost_usd_micros: "615770000",
				},
			],
		});

		expect(report).toMatchObject({
			workspaceId: "workspace-a",
			agentId: "agent-1",
			period: { from: "2026-04-01T00:00:00.000Z" },
			attribution: {
				outcomeCount: 3,
				actionCount: 2,
				traceCount: 1,
				revenueUsd: 156000,
				pipelineValueUsd: 487000,
			},
			cost: {
				costUsd: 1847.32,
				totalDurationMs: 452100,
			},
			roi: {
				netRevenueUsd: 154152.68,
				costPerOutcome: 615.7733333333333,
			},
			byOutcomeType: [
				{
					outcomeType: "closed_won",
					outcomeCount: 1,
					revenueUsd: 156000,
				},
			],
		});
		expect(report.roi.revenuePerDollarSpent).toBeCloseTo(84.4460571);
	});
});

describe("revenue attribution REST handler", () => {
	afterEach(() => {
		setRevenueAttributionServiceForTest(null);
		vi.restoreAllMocks();
	});

	it("records business outcomes through the REST handler", async () => {
		const outcome = {
			id: "id-1",
			workspaceId: "workspace-a",
			agentId: "agent-1",
			outcomeId: "deal-1",
			outcomeType: "closed_won",
			attributionModel: "direct",
			attributionWeightBps: 10000,
			revenueUsd: 100,
			pipelineValueUsd: 250,
			costUsd: 2.5,
			durationMs: 100,
			occurredAt: "2026-04-20T12:00:00.000Z",
			createdAt: "2026-04-20T12:00:00.000Z",
			updatedAt: "2026-04-20T12:00:00.000Z",
			metadata: {},
		};
		const recordOutcome = vi.fn().mockResolvedValue(outcome);
		setRevenueAttributionServiceForTest({
			recordOutcome,
			queryRoi: vi.fn(),
		} as unknown as RevenueAttributionService);

		const req = createRequest("POST", "/api/attribution/record-outcome", {
			workspaceId: "workspace-a",
			agentId: "agent-1",
			outcomeId: "deal-1",
			outcomeType: "closed_won",
			revenueUsd: 100,
		});
		const res = createResponse();

		await handleRevenueAttribution(req, res as unknown as ServerResponse, {});

		expect(recordOutcome).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceId: "workspace-a",
				agentId: "agent-1",
				outcomeId: "deal-1",
			}),
		);
		expect(res.statusCode).toBe(201);
		expect(parseJsonResponse(res)).toEqual({ outcome });
	});

	it("returns ROI reports by agent id with workspace and date filters", async () => {
		const roi = createRevenueAttributionRoiReport({
			query: { workspaceId: "workspace-a", agentId: "agent-1" },
		});
		const queryRoi = vi.fn().mockResolvedValue(roi);
		setRevenueAttributionServiceForTest({
			recordOutcome: vi.fn(),
			queryRoi,
		} as unknown as RevenueAttributionService);

		const req = createRequest(
			"GET",
			"/api/attribution/roi/agent-1?workspace_id=workspace-a&from=2026-04-01",
		);
		const res = createResponse();

		await handleRevenueAttribution(
			req,
			res as unknown as ServerResponse,
			{},
			{ agentId: "agent-1" },
		);

		expect(queryRoi).toHaveBeenCalledWith({
			agentId: "agent-1",
			workspaceId: "workspace-a",
			from: new Date("2026-04-01"),
		});
		expect(res.statusCode).toBe(200);
		expect(parseJsonResponse(res)).toEqual({ roi });
	});

	it("returns unavailable when attribution storage is not configured", async () => {
		setRevenueAttributionServiceForTest({
			recordOutcome: vi
				.fn()
				.mockRejectedValue(new RevenueAttributionUnavailableError()),
			queryRoi: vi.fn(),
		} as unknown as RevenueAttributionService);

		const req = createRequest("POST", "/api/attribution/record-outcome", {
			workspaceId: "workspace-a",
			agentId: "agent-1",
			outcomeId: "deal-1",
			outcomeType: "closed_won",
		});
		const res = createResponse();

		await handleRevenueAttribution(req, res as unknown as ServerResponse, {});

		expect(res.statusCode).toBe(503);
		expect(parseJsonResponse(res)).toEqual({
			error: "Revenue attribution database is not configured.",
		});
	});
});
