import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	initOpenTelemetry: vi.fn(),
	launchNativeCli: vi.fn(async () => 0),
}));

vi.mock("../../src/opentelemetry.js", () => ({
	initOpenTelemetry: mocks.initOpenTelemetry,
}));

vi.mock("../../src/cli/native-tui-launcher.js", () => ({
	launchNativeCli: mocks.launchNativeCli,
	launchNativeTui: vi.fn(async () => 0),
	shouldLaunchNativeInteractiveTui: () => false,
	shouldLaunchNativePrint: () => false,
	shouldLaunchNativeHeadless: () => false,
	isNativeCliHelperCommand: (command?: string) =>
		[
			"models",
			"sessions",
			"cost",
			"stats",
			"status",
			"hooks",
			"export",
			"import",
		].includes(command ?? ""),
	buildNativeTuiCliArgs: () => [],
	resolveMaestroTuiBinary: () => "/tmp/fake-maestro-tui",
	MaestroTuiBinaryNotFoundError: class MaestroTuiBinaryNotFoundError extends Error {
		readonly code = "MAESTRO_TUI_NOT_FOUND" as const;
	},
}));

import { main } from "../../src/main.js";

const originalEnv = { ...process.env };

function resetEnv() {
	for (const key of Object.keys(process.env)) {
		if (!(key in originalEnv)) {
			delete process.env[key];
		}
	}
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}

async function runModelsListCommand() {
	const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
		throw new Error(`process.exit(${Number(code ?? 0)})`);
	});
	try {
		await expect(main(["models", "list"])).rejects.toThrow("process.exit(0)");
	} finally {
		exitSpy.mockRestore();
	}
}

describe("main observability startup", () => {
	beforeEach(() => {
		mocks.initOpenTelemetry.mockReset();
		mocks.launchNativeCli.mockReset().mockResolvedValue(0);
		vi.spyOn(console, "log").mockImplementation(() => {});
		resetEnv();
		delete process.env.MAESTRO_INTERNAL_TELEMETRY_DISABLED;
		delete process.env.EVALOPS_INTERNAL_TELEMETRY_DISABLED;
		delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
		delete process.env.OTEL_TRACES_EXPORTER;
		delete process.env.OTEL_METRICS_EXPORTER;
		delete process.env.OTEL_LOGS_EXPORTER;
		process.env.MAESTRO_TELEMETRY = "0";
	});

	afterEach(() => {
		resetEnv();
		vi.restoreAllMocks();
	});

	it("starts OpenTelemetry for whitespace-padded MAESTRO_OTEL=true", async () => {
		process.env.MAESTRO_OTEL = " true";

		await runModelsListCommand();

		await vi.waitFor(() => {
			expect(mocks.initOpenTelemetry).toHaveBeenCalledWith("composer-cli");
		});
		expect(mocks.launchNativeCli).toHaveBeenCalled();
	});

	it("does not start OpenTelemetry for whitespace-padded MAESTRO_OTEL=false even when an exporter is configured", async () => {
		process.env.MAESTRO_OTEL = " false";
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://otel.example.test";

		await runModelsListCommand();
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));

		expect(mocks.initOpenTelemetry).not.toHaveBeenCalled();
	});
});
