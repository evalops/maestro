import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DbClient } from "../../src/db/client.js";
import { handleTraces } from "../../src/server/handlers/traces.js";
import {
	type ExecutionTrace,
	TracesService,
	TracesUnavailableError,
	TracesValidationError,
	exportTraceToOpenTelemetry,
	normalizeExecutionTraceInput,
	setTracesServiceForTest,
} from "../../src/services/traces/index.js";

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

function sampleTrace(): ExecutionTrace {
	return normalizeExecutionTraceInput({
		traceId: "0123456789abcdef0123456789abcdef",
		workspaceId: "workspace-a",
		agentId: "agent-1",
		status: "completed",
		durationMs: 250,
		createdAt: "2026-04-20T12:00:00.000Z",
		spans: [
			{
				spanId: "1111111111111111",
				name: "agent/run",
				kind: "reasoning",
				status: "ok",
				startTime: "2026-04-20T12:00:00.000Z",
				durationMs: 250,
				attributes: {
					"gen_ai.system": "anthropic",
					"gen_ai.request.model": "claude-sonnet",
				},
				children: [
					{
						spanId: "2222222222222222",
						name: "tool/call",
						kind: "tool_call",
						status: "ok",
						durationMs: 25,
						attributes: { "maestro.tool.name": "read" },
					},
				],
			},
		],
	});
}

describe("traces service", () => {
	afterEach(() => {
		setTracesServiceForTest(null);
		vi.restoreAllMocks();
	});

	it("normalizes trace payloads with generated ids and nested span parents", () => {
		const trace = normalizeExecutionTraceInput({
			workspaceId: " workspace-a ",
			agentId: " agent-1 ",
			status: "completed",
			spans: [
				{
					name: "agent/run",
					kind: "reasoning",
					durationMs: 120.9,
					children: [{ name: "llm/call", kind: "llm_inference" }],
				},
			],
		});

		expect(trace.traceId).toMatch(/^[0-9a-f]{32}$/);
		expect(trace.workspaceId).toBe("workspace-a");
		expect(trace.agentId).toBe("agent-1");
		expect(trace.durationMs).toBe(120);
		expect(trace.spans[0]?.name).toBe("agent.run");
		expect(trace.spans[0]?.children?.[0]?.name).toBe("llm.call");
		expect(trace.spans[0]?.spanId).toMatch(/^[0-9a-f]{16}$/);
		expect(trace.spans[0]?.children?.[0]?.parentSpanId).toBe(
			trace.spans[0]?.spanId,
		);
	});

	it("rejects invalid trace statuses", () => {
		expect(() =>
			normalizeExecutionTraceInput({
				workspaceId: "workspace-a",
				agentId: "agent-1",
				status: "unknown" as "completed",
				spans: [],
			}),
		).toThrow(TracesValidationError);
	});

	it("rejects null date values instead of coercing them to epoch", () => {
		expect(() =>
			normalizeExecutionTraceInput({
				workspaceId: "workspace-a",
				agentId: "agent-1",
				createdAt: null as unknown as string,
				spans: [],
			}),
		).toThrow(TracesValidationError);
		expect(() =>
			normalizeExecutionTraceInput({
				workspaceId: "workspace-a",
				agentId: "agent-1",
				spans: [
					{
						name: "agent run",
						startTime: null as unknown as string,
					},
				],
			}),
		).toThrow(TracesValidationError);
	});

	it("exports traces in an OpenTelemetry-compatible shape", () => {
		const exported = exportTraceToOpenTelemetry(sampleTrace());
		const resourceSpan = exported.resourceSpans[0];
		const otelSpans = resourceSpan?.scopeSpans[0]?.spans ?? [];

		expect(resourceSpan?.resource.attributes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ key: "service.name" }),
				expect.objectContaining({ key: "maestro.workspace_id" }),
				expect.objectContaining({ key: "maestro.agent_id" }),
			]),
		);
		expect(otelSpans).toHaveLength(2);
		expect(otelSpans[0]).toMatchObject({
			traceId: "0123456789abcdef0123456789abcdef",
			spanId: "1111111111111111",
			name: "agent.run",
			kind: "SPAN_KIND_INTERNAL",
			status: { code: "STATUS_CODE_OK" },
		});
		expect(otelSpans[1]?.name).toBe("tool.call");
		expect(otelSpans[1]?.parentSpanId).toBe("1111111111111111");
	});

	it("exports legacy slash-delimited span names using dot notation", () => {
		const trace = {
			...sampleTrace(),
			spans: [
				{
					...sampleTrace().spans[0]!,
					name: "agent/run",
					children: [
						{
							...sampleTrace().spans[0]!.children![0]!,
							name: "tool/call",
						},
					],
				},
			],
		};

		const exported = exportTraceToOpenTelemetry(trace);
		const spans = exported.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];

		expect(spans.map((span) => span.name)).toEqual(["agent.run", "tool.call"]);
	});

	it("records traces through the REST handler", async () => {
		const trace = sampleTrace();
		const recordTrace = vi.fn().mockResolvedValue(trace);
		setTracesServiceForTest({
			recordTrace,
			getTrace: vi.fn(),
			listTraces: vi.fn(),
			summarizeTrace: vi.fn(),
		} as unknown as TracesService);

		const req = createRequest("POST", "/api/traces", {
			workspaceId: "workspace-a",
			agentId: "agent-1",
			spans: [{ name: "agent run" }],
		});
		const res = createResponse();

		await handleTraces(req, res as unknown as ServerResponse, {});

		expect(recordTrace).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceId: "workspace-a",
				agentId: "agent-1",
			}),
		);
		expect(res.statusCode).toBe(201);
		expect(parseJsonResponse(res)).toEqual({ trace });
	});

	it("returns a single trace as OpenTelemetry JSON when requested", async () => {
		const trace = sampleTrace();
		const getTrace = vi.fn().mockResolvedValue(trace);
		setTracesServiceForTest({
			recordTrace: vi.fn(),
			getTrace,
			listTraces: vi.fn(),
			summarizeTrace: vi.fn(),
		} as unknown as TracesService);

		const req = createRequest(
			"GET",
			"/api/traces/0123456789abcdef0123456789abcdef?format=otel",
		);
		const res = createResponse();

		await handleTraces(
			req,
			res as unknown as ServerResponse,
			{},
			{ id: "0123456789abcdef0123456789abcdef" },
		);

		expect(getTrace).toHaveBeenCalledWith("0123456789abcdef0123456789abcdef");
		expect(res.statusCode).toBe(200);
		expect(parseJsonResponse(res)).toEqual(exportTraceToOpenTelemetry(trace));
	});

	it("lists traces with workspace filters and offset pagination", async () => {
		const listTraces = vi.fn().mockResolvedValue({
			traces: [],
			pagination: { limit: 2, offset: 10, hasMore: false },
		});
		setTracesServiceForTest({
			recordTrace: vi.fn(),
			getTrace: vi.fn(),
			listTraces,
			summarizeTrace: vi.fn(),
		} as unknown as TracesService);

		const req = createRequest(
			"GET",
			"/api/traces?workspace_id=workspace-a&agent_id=agent-1&status=completed&limit=2&offset=10",
		);
		const res = createResponse();

		await handleTraces(req, res as unknown as ServerResponse, {});

		expect(listTraces).toHaveBeenCalledWith({
			workspaceId: "workspace-a",
			agentId: "agent-1",
			status: "completed",
			limit: 2,
			offset: 10,
		});
		expect(res.statusCode).toBe(200);
		expect(parseJsonResponse(res)).toEqual({
			traces: [],
			pagination: { limit: 2, offset: 10, hasMore: false },
		});
	});

	it("counts nested spans consistently when listing traces from storage", async () => {
		const execute = vi.fn().mockResolvedValue([
			{
				trace_id: "0123456789abcdef0123456789abcdef",
				workspace_id: "workspace-a",
				agent_id: "agent-1",
				duration_ms: 250,
				status: "completed",
				spans: [
					{
						spanId: "1111111111111111",
						name: "agent run",
						kind: "reasoning",
						status: "ok",
						attributes: {},
						children: [
							{
								spanId: "2222222222222222",
								name: "llm call",
								kind: "llm_inference",
								status: "ok",
								attributes: {},
							},
						],
					},
				],
				created_at: new Date("2026-04-20T12:00:00.000Z"),
			},
		]);
		const service = new TracesService(
			() => ({ execute }) as unknown as DbClient,
			() => true,
		);

		const result = await service.listTraces({
			workspaceId: "workspace-a",
			limit: 10,
			offset: 0,
		});

		expect(result.traces[0]?.spanCount).toBe(2);
	});

	it("returns 404 when a trace id is not found", async () => {
		setTracesServiceForTest({
			recordTrace: vi.fn(),
			getTrace: vi.fn().mockResolvedValue(null),
			listTraces: vi.fn(),
			summarizeTrace: vi.fn(),
		} as unknown as TracesService);

		const req = createRequest("GET", "/api/traces/missing");
		const res = createResponse();

		await handleTraces(
			req,
			res as unknown as ServerResponse,
			{},
			{ id: "missing" },
		);

		expect(res.statusCode).toBe(404);
		expect(parseJsonResponse(res)).toEqual({ error: "Trace not found." });
	});

	it("returns unavailable when trace storage is not configured", async () => {
		setTracesServiceForTest({
			recordTrace: vi.fn().mockRejectedValue(new TracesUnavailableError()),
			getTrace: vi.fn(),
			listTraces: vi.fn(),
			summarizeTrace: vi.fn(),
		} as unknown as TracesService);

		const req = createRequest("POST", "/api/traces", {
			workspaceId: "workspace-a",
			agentId: "agent-1",
			spans: [],
		});
		const res = createResponse();

		await handleTraces(req, res as unknown as ServerResponse, {});

		expect(res.statusCode).toBe(503);
		expect(parseJsonResponse(res)).toEqual({
			error: "Traces database is not configured.",
		});
	});
});
