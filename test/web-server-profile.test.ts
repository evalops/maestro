import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	startAutomationScheduler: vi.fn(),
	reloadModelConfig: vi.fn(async () => {}),
	initLifecycle: vi.fn(async () => {}),
	shutdownLifecycle: vi.fn(async () => {}),
	bootstrapLsp: vi.fn(async () => {}),
	initCheckpointService: vi.fn(),
	disposeCheckpointService: vi.fn(),
	loadEnv: vi.fn(),
	scrubLoadedSecurityOverrideEnv: vi.fn(),
	initOpenTelemetry: vi.fn(),
	initSentry: vi.fn(),
	captureSentryException: vi.fn(),
	flushSentry: vi.fn(async () => {}),
	loadMcpConfig: vi.fn(() => ({ servers: [] })),
	mcpOn: vi.fn(),
	mcpConfigure: vi.fn(async () => {}),
	registerBackgroundTaskShutdownHooks: vi.fn(),
	configureSafeMode: vi.fn(),
	enterpriseInitialize: vi.fn(async () => {}),
	isDatabaseConfigured: vi.fn(() => false),
	startStatsCollection: vi.fn(),
	stopStatsCollection: vi.fn(),
	logStartup: vi.fn(),
	logRequest: vi.fn(),
	logError: vi.fn(),
}));

vi.mock("../src/load-env.js", () => ({
	loadEnv: mocks.loadEnv,
	scrubLoadedSecurityOverrideEnv: mocks.scrubLoadedSecurityOverrideEnv,
}));

vi.mock("../src/opentelemetry.js", () => ({
	initOpenTelemetry: mocks.initOpenTelemetry,
}));

vi.mock("../src/sentry.js", () => ({
	initSentry: mocks.initSentry,
	captureSentryException: mocks.captureSentryException,
	flushSentry: mocks.flushSentry,
}));

vi.mock("../src/server/automations/scheduler.js", () => ({
	startAutomationScheduler: mocks.startAutomationScheduler,
}));

vi.mock("../src/models/registry.js", async () => {
	const actual = await vi.importActual<
		typeof import("../src/models/registry.js")
	>("../src/models/registry.js");
	return {
		...actual,
		getFactoryDefaultModelSelection: vi.fn(() => undefined),
		reloadModelConfig: mocks.reloadModelConfig,
	};
});

vi.mock("../src/lifecycle.js", () => ({
	initLifecycle: mocks.initLifecycle,
	shutdownLifecycle: mocks.shutdownLifecycle,
}));

vi.mock("../src/lsp/bootstrap.js", () => ({
	bootstrapLsp: mocks.bootstrapLsp,
}));

vi.mock("../src/checkpoints/index.js", () => ({
	initCheckpointService: mocks.initCheckpointService,
	disposeCheckpointService: mocks.disposeCheckpointService,
}));

vi.mock("../src/mcp/index.js", async () => {
	const actual = await vi.importActual<typeof import("../src/mcp/index.js")>(
		"../src/mcp/index.js",
	);
	return {
		...actual,
		loadMcpConfig: mocks.loadMcpConfig,
	};
});

vi.mock("../src/runtime/background-task-hooks.js", () => ({
	registerBackgroundTaskShutdownHooks:
		mocks.registerBackgroundTaskShutdownHooks,
}));

vi.mock("../src/safety/safe-mode.js", () => ({
	configureSafeMode: mocks.configureSafeMode,
}));

vi.mock("../src/enterprise/context.js", () => ({
	enterpriseContext: {
		initialize: mocks.enterpriseInitialize,
		isEnterprise: () => false,
		endSession: vi.fn(),
	},
}));

vi.mock("../src/db/client.js", async () => {
	const actual = await vi.importActual<typeof import("../src/db/client.js")>(
		"../src/db/client.js",
	);
	return {
		...actual,
		isDatabaseConfigured: mocks.isDatabaseConfigured,
	};
});

vi.mock("../src/server/logger.js", async () => {
	const actual = await vi.importActual<
		typeof import("../src/server/logger.js")
	>("../src/server/logger.js");
	return {
		...actual,
		isOverloaded: () => false,
		logError: mocks.logError,
		logRequest: mocks.logRequest,
		logStartup: mocks.logStartup,
		startStatsCollection: mocks.startStatsCollection,
		stopStatsCollection: mocks.stopStatsCollection,
	};
});

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

async function importWebServer() {
	vi.resetModules();
	return await import("../src/web-server.js");
}

describe("startWebServer profile hardening", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetEnv();
		process.env.NODE_ENV = "test";
		process.env.VITEST = "true";
		process.env.MAESTRO_WEB_REQUIRE_KEY = "0";
		process.env.MAESTRO_WEB_REQUIRE_REDIS = "0";
		delete process.env.MAESTRO_PROFILE;
		delete process.env.MAESTRO_WEB_PROFILE;
		delete process.env.MAESTRO_WEB_CSRF_TOKEN;
		delete process.env.MAESTRO_FAIL_UNTAGGED_EGRESS;
		delete process.env.MAESTRO_BACKGROUND_SHELL_DISABLE;
	});

	afterEach(() => {
		resetEnv();
	});

	it("applies prod approval and hardening when profileName is supplied at start time", async () => {
		process.env.MAESTRO_WEB_CSRF_TOKEN = "csrf-token";
		const { startWebServer } = await importWebServer();

		const server = await startWebServer(0, {
			profileName: "prod",
			skipStartupMigration: true,
		});
		await once(server, "listening");

		expect(mocks.startAutomationScheduler).toHaveBeenCalledWith(
			expect.objectContaining({
				defaultApprovalMode: "fail",
			}),
		);
		expect(process.env.MAESTRO_FAIL_UNTAGGED_EGRESS).toBe("1");
		expect(process.env.MAESTRO_BACKGROUND_SHELL_DISABLE).toBe("1");

		server.close();
		await once(server, "close");
	});

	it("enforces prod CSRF requirements even when the module was imported under a non-prod env", async () => {
		const { startWebServer } = await importWebServer();

		await expect(
			startWebServer(0, {
				profileName: "prod",
				skipStartupMigration: true,
			}),
		).rejects.toThrow(
			"MAESTRO_WEB_CSRF_TOKEN is required when CSRF enforcement is enabled",
		);
	});

	it("clears prod-only env hardening when startup downgrades to a non-prod profile", async () => {
		process.env.MAESTRO_PROFILE = "prod";
		process.env.MAESTRO_WEB_CSRF_TOKEN = "csrf-token";
		const { startWebServer } = await importWebServer();

		expect(process.env.MAESTRO_FAIL_UNTAGGED_EGRESS).toBe("1");
		expect(process.env.MAESTRO_BACKGROUND_SHELL_DISABLE).toBe("1");

		delete process.env.MAESTRO_PROFILE;

		const server = await startWebServer(0, {
			profileName: "dev",
			skipStartupMigration: true,
		});
		await once(server, "listening");

		expect(process.env.MAESTRO_FAIL_UNTAGGED_EGRESS).toBeUndefined();
		expect(process.env.MAESTRO_BACKGROUND_SHELL_DISABLE).toBeUndefined();

		server.close();
		await once(server, "close");
	});
});
