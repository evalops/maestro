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

	it("reports MAESTRO_OTEL=true as the enable reason (tri-state, not literal '1')", async () => {
		// Bugbot caught: the reason keyed on `env.otelFlag === "1"` but the
		// parser accepts true/false/1/0 case-insensitively. So
		// MAESTRO_OTEL=true would say "OTEL exporter detected" (or worse,
		// "no OTEL exporter configured" when no exporter was set) even
		// though it IS the opt-in trigger.
		vi.stubEnv("MAESTRO_OTEL", "true");

		const { getOpenTelemetryStatus, isOpenTelemetryEnabled } = await import(
			"../../src/opentelemetry.js"
		);

		expect(isOpenTelemetryEnabled()).toBe(true);
		expect(getOpenTelemetryStatus()).toMatchObject({
			enabled: true,
			reason: "MAESTRO_OTEL=true",
		});
	});

	it("reports MAESTRO_OTEL=false as the disable reason (tri-state, not literal '0')", async () => {
		vi.stubEnv("MAESTRO_OTEL", "false");

		const { getOpenTelemetryStatus, isOpenTelemetryEnabled } = await import(
			"../../src/opentelemetry.js"
		);

		expect(isOpenTelemetryEnabled()).toBe(false);
		expect(getOpenTelemetryStatus()).toMatchObject({
			enabled: false,
			reason: "MAESTRO_OTEL=false",
		});
	});
});
