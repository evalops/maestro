import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("OpenTelemetry status", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.unstubAllEnvs();
	});

	afterEach(() => {
		vi.resetModules();
		vi.unstubAllEnvs();
	});

	it("reports policy disablement as the status reason", async () => {
		vi.stubEnv("MAESTRO_INTERNAL_TELEMETRY_DISABLED", "1");
		vi.stubEnv("MAESTRO_OTEL", "1");
		vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://otel.example.test");

		const { getOpenTelemetryStatus, isOpenTelemetryEnabled } = await import(
			"../../src/opentelemetry.js"
		);

		expect(isOpenTelemetryEnabled()).toBe(false);
		expect(getOpenTelemetryStatus()).toMatchObject({
			enabled: false,
			reason: "internal telemetry disabled",
			otlpEndpoint: "http://otel.example.test",
		});
	});
});
