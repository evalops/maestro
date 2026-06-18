import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveOAuthCredentials } from "../../src/oauth/storage.js";
import { resetDefaultRuntimeEnvForTests } from "../../src/runtime/env.js";

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

	it("does not write the default telemetry file for meter-only destinations", async () => {
		const maestroHome = await mkdtemp(join(tmpdir(), "maestro-meter-only-"));
		vi.stubEnv("MAESTRO_HOME", maestroHome);
		vi.stubEnv("MAESTRO_DISABLE_KEYCHAIN", "1");
		vi.stubEnv("MAESTRO_TELEMETRY_FILE", "");
		vi.stubEnv("PLAYWRIGHT_TELEMETRY_FILE", "");
		vi.stubEnv("MAESTRO_TELEMETRY_ENDPOINT", "");
		vi.stubEnv("PLAYWRIGHT_TELEMETRY_ENDPOINT", "");
		vi.stubEnv("MAESTRO_METER_BASE", "http://meter.test");
		vi.stubEnv("MAESTRO_METER_ACCESS_TOKEN", "meter-token");
		vi.stubEnv("MAESTRO_EVALOPS_ORG_ID", "org_evalops");
		const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		const telemetry = await import("../../src/telemetry.js");

		await telemetry.recordTelemetry(createCanonicalTurnEvent());

		expect(fetchMock).toHaveBeenCalledTimes(1);
		await expect(access(join(maestroHome, "telemetry.log"))).rejects.toThrow();
	});

	it("refreshes meter-backed enablement when OAuth credentials appear later", async () => {
		vi.stubEnv("MAESTRO_METER_BASE", "http://meter.test");
		vi.stubEnv("MAESTRO_METER_ACCESS_TOKEN", "");
		vi.stubEnv("MAESTRO_EVALOPS_ORG_ID", "");
		const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		const telemetry = await import("../../src/telemetry.js");

		expect(telemetry.getTelemetryStatus()).toEqual(
			expect.objectContaining({
				enabled: false,
			}),
		);

		saveOAuthCredentials("evalops", {
			type: "oauth",
			access: "oauth-access",
			refresh: "oauth-refresh",
			expires: Date.now() + 60_000,
			metadata: {
				organizationId: "org_evalops",
			},
		});

		expect(telemetry.getTelemetryStatus()).toEqual(
			expect.objectContaining({
				enabled: true,
				reason: "meter",
			}),
		);

		await telemetry.recordTelemetry(createCanonicalTurnEvent());

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("refreshes telemetry status after the default RuntimeEnv snapshot is reset", async () => {
		const telemetry = await import("../../src/telemetry.js");

		vi.stubEnv("MAESTRO_TELEMETRY", "1");
		vi.stubEnv("MAESTRO_TELEMETRY_FILE", "/tmp/maestro-telemetry.jsonl");
		resetDefaultRuntimeEnvForTests();
		expect(telemetry.getTelemetryStatus()).toEqual(
			expect.objectContaining({
				enabled: true,
				reason: "file",
			}),
		);

		vi.stubEnv("MAESTRO_TELEMETRY", "0");
		resetDefaultRuntimeEnvForTests();
		expect(telemetry.getTelemetryStatus()).toEqual(
			expect.objectContaining({
				enabled: false,
				reason: "flag disabled",
			}),
		);
	});
});
