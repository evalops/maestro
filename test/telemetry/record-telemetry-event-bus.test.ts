import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("recordTelemetry event bus safety", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.unstubAllEnvs();
	});

	afterEach(() => {
		vi.resetModules();
		vi.unstubAllEnvs();
	});

	it("swallows event bus failures when legacy telemetry is disabled", async () => {
		vi.stubEnv("MAESTRO_TELEMETRY", "0");

		const mirrorTelemetryToMaestroEventBus = vi
			.fn<
				typeof import(
					"../../src/telemetry/maestro-event-bus.js",
				)["mirrorTelemetryToMaestroEventBus"]
			>()
			.mockRejectedValue(new Error("event bus failed"));

		vi.doMock("../../src/telemetry/maestro-event-bus.js", async () => {
			const actual = await vi.importActual<
				typeof import("../../src/telemetry/maestro-event-bus.js")
			>("../../src/telemetry/maestro-event-bus.js");
			return {
				...actual,
				mirrorTelemetryToMaestroEventBus,
			};
		});

		const telemetry = await import("../../src/telemetry.js");

		await expect(
			telemetry.recordTelemetry({
				type: "tool-execution",
				timestamp: "2026-04-22T16:00:00.000Z",
				toolName: "read",
				success: true,
				durationMs: 10,
			}),
		).resolves.toBeUndefined();
		expect(mirrorTelemetryToMaestroEventBus).toHaveBeenCalledTimes(1);
	});

	it("swallows event bus failures when sampling skips legacy telemetry", async () => {
		vi.stubEnv("MAESTRO_TELEMETRY", "1");
		vi.stubEnv("MAESTRO_TELEMETRY_SAMPLE", "0.1");

		const mirrorTelemetryToMaestroEventBus = vi
			.fn<
				typeof import(
					"../../src/telemetry/maestro-event-bus.js",
				)["mirrorTelemetryToMaestroEventBus"]
			>()
			.mockRejectedValue(new Error("event bus failed"));

		vi.spyOn(Math, "random").mockReturnValue(0.9);

		vi.doMock("../../src/telemetry/maestro-event-bus.js", async () => {
			const actual = await vi.importActual<
				typeof import("../../src/telemetry/maestro-event-bus.js")
			>("../../src/telemetry/maestro-event-bus.js");
			return {
				...actual,
				mirrorTelemetryToMaestroEventBus,
			};
		});

		const telemetry = await import("../../src/telemetry.js");

		await expect(
			telemetry.recordTelemetry({
				type: "tool-execution",
				timestamp: "2026-04-22T16:00:00.000Z",
				toolName: "read",
				success: true,
				durationMs: 10,
			}),
		).resolves.toBeUndefined();
		expect(mirrorTelemetryToMaestroEventBus).toHaveBeenCalledTimes(1);
	});
});
