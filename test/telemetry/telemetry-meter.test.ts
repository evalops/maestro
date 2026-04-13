import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function createCanonicalTurnEvent() {
	return {
		type: "canonical-turn" as const,
		timestamp: "2026-04-13T17:45:00.000Z",
		sessionId: "session-123",
		turnId: "turn-456",
		turnNumber: 3,
		traceId: "trace-789",
		model: {
			id: "claude-opus-4-6",
			provider: "anthropic",
			thinkingLevel: "medium" as const,
		},
		totalDurationMs: 620,
		llmDurationMs: 450,
		toolDurationMs: 120,
		queueWaitMs: 25,
		tools: [],
		toolCount: 0,
		toolSuccessCount: 0,
		toolFailureCount: 0,
		tokens: {
			input: 120,
			output: 48,
			cacheRead: 4,
			cacheWrite: 2,
		},
		costUsd: 0.08,
		sandboxMode: "docker" as const,
		approvalMode: "auto" as const,
		mcpServerCount: 1,
		mcpServers: ["context7"],
		contextSourceCount: 2,
		messageCount: 3,
		inputSizeBytes: 1024,
		outputSizeBytes: 2048,
		features: {
			safeMode: true,
			guardianEnabled: false,
			compactionEnabled: true,
			hookCount: 1,
		},
		status: "success" as const,
		sampled: true,
		sampleReason: "random" as const,
	};
}

describe("telemetry meter integration", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	afterEach(() => {
		vi.resetModules();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("treats meter as a telemetry destination for canonical turns", async () => {
		vi.stubEnv("MAESTRO_METER_BASE", "http://meter.test");
		vi.stubEnv("MAESTRO_METER_ACCESS_TOKEN", "meter-token");
		vi.stubEnv("MAESTRO_EVALOPS_ORG_ID", "org_evalops");
		const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		const telemetry = await import("../../src/telemetry.js");

		expect(telemetry.getTelemetryStatus()).toEqual(
			expect.objectContaining({
				enabled: true,
				reason: "meter",
			}),
		);

		await telemetry.recordTelemetry(createCanonicalTurnEvent());

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
			"http://meter.test/meter.v1.MeterService/IngestWideEvent",
		);
	});
});
