import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getRemoteMeterEventDashboard,
	hasRemoteMeterDestination,
	mirrorCanonicalTurnEventToMeter,
	queryRemoteMeterWideEvents,
} from "../../src/telemetry/meter-service-client.js";
import { TurnCollector } from "../../src/telemetry/wide-events.js";

function createCanonicalTurnEvent() {
	const collector = new TurnCollector("session-123", 1);
	collector
		.setModel({
			id: "claude-opus-4-6",
			provider: "anthropic",
			thinkingLevel: "medium",
		})
		.setSandboxMode("docker")
		.setApprovalMode("auto")
		.setMcpServers(["context7"]);
	return collector.complete(
		"success",
		{
			input: 101,
			output: 47,
			cacheRead: 3,
			cacheWrite: 2,
		},
		0.12,
	);
}

describe("meter telemetry client", () => {
	beforeEach(() => {
		vi.stubEnv("MAESTRO_METER_BASE", "http://meter.test/");
		vi.stubEnv("MAESTRO_METER_ACCESS_TOKEN", "meter-token");
		vi.stubEnv("MAESTRO_EVALOPS_ORG_ID", "org_evalops");
		vi.stubEnv("MAESTRO_EVALOPS_TEAM_ID", "team_ops");
		vi.stubEnv("MAESTRO_METER_TIMEOUT_MS", "2500");
		vi.unstubAllGlobals();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("detects when remote meter mirroring is configured", () => {
		expect(hasRemoteMeterDestination()).toBe(true);
	});

	it("mirrors sampled canonical turns to meter over Connect", async () => {
		const event = createCanonicalTurnEvent();
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
			expect(String(input)).toBe(
				"http://meter.test/meter.v1.MeterService/IngestWideEvent",
			);
			expect(init?.headers).toEqual(
				expect.objectContaining({
					Authorization: "Bearer meter-token",
					"Connect-Protocol-Version": "1",
					"X-Organization-ID": "org_evalops",
				}),
			);
			expect(JSON.parse(String(init?.body ?? "{}"))).toEqual({
				timestamp: event.timestamp,
				teamId: "team_ops",
				agentId: "maestro",
				surface: "maestro",
				eventType: "canonical-turn",
				model: "claude-opus-4-6",
				provider: "anthropic",
				requestId: event.turnId,
				metadata: {
					sessionId: "session-123",
					turnId: event.turnId,
					status: "success",
					sampleReason: "first_turn",
					sampled: "true",
					sandboxMode: "docker",
					approvalMode: "auto",
					thinkingLevel: "medium",
				},
				data: event,
				metrics: {
					inputTokens: 101,
					outputTokens: 47,
					cacheReadTokens: 3,
					cacheWriteTokens: 2,
					totalCostUsd: 0.12,
					durationMs: expect.any(Number),
					toolCallsCount: 0,
				},
			});
			return new Response(JSON.stringify({ event: { id: "wide_event_1" } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await mirrorCanonicalTurnEventToMeter(event);

		expect(result).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("treats empty successful ingest responses as mirrored", async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchMock);

		const result = await mirrorCanonicalTurnEventToMeter(
			createCanonicalTurnEvent(),
		);

		expect(result).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("treats non-JSON successful ingest responses as mirrored", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response("accepted", {
					status: 202,
					headers: { "Content-Type": "text/plain" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await mirrorCanonicalTurnEventToMeter(
			createCanonicalTurnEvent(),
		);

		expect(result).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("queries wide events through the shared meter service", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
			expect(String(input)).toBe(
				"http://meter.test/meter.v1.MeterService/QueryWideEvents",
			);
			expect(init?.headers).toEqual(
				expect.objectContaining({
					Authorization: "Bearer meter-token",
					"Connect-Protocol-Version": "1",
					"X-Organization-ID": "org_evalops",
				}),
			);
			expect(JSON.parse(String(init?.body ?? "{}"))).toEqual({
				teamId: "team_ops",
				agentId: "maestro",
				eventType: "canonical-turn",
				limit: 10,
			});
			return new Response(
				JSON.stringify({
					events: [{ id: "wide_event_1" }],
					total: 1,
					hasMore: false,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			queryRemoteMeterWideEvents({
				agentId: "maestro",
				eventType: "canonical-turn",
				limit: 10,
			}),
		).resolves.toEqual({
			events: [{ id: "wide_event_1" }],
			total: 1,
			hasMore: false,
		});
	});

	it("fetches the meter dashboard through the shared meter service", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
			expect(String(input)).toBe(
				"http://meter.test/meter.v1.MeterService/GetEventDashboard",
			);
			expect(JSON.parse(String(init?.body ?? "{}"))).toEqual({
				teamId: "team_ops",
				surface: "maestro",
			});
			return new Response(
				JSON.stringify({
					totalEvents: 2,
					bySurface: [{ surface: "maestro", count: 2 }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			getRemoteMeterEventDashboard({ surface: "maestro" }),
		).resolves.toEqual({
			totalEvents: 2,
			bySurface: [{ surface: "maestro", count: 2 }],
		});
	});

	it("skips remote mirroring when required meter config is missing", async () => {
		vi.stubEnv("MAESTRO_EVALOPS_ORG_ID", "");
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const result = await mirrorCanonicalTurnEventToMeter(
			createCanonicalTurnEvent(),
		);

		expect(hasRemoteMeterDestination()).toBe(false);
		expect(result).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
