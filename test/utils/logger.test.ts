import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("logger stream routing", () => {
	beforeEach(() => {
		// The global setup file `restore-oauth-storage.ts` imports
		// `src/oauth/storage.ts`, which transitively imports
		// `src/utils/logger.ts` and instantiates `export const logger`
		// with the env-at-setup-time (MAESTRO_LOG_LEVEL=warn from
		// `suppress-warnings.ts`). Without resetting the module cache,
		// `await import("../../src/utils/logger.js")` below returns the
		// already-cached Logger whose `minLevel` was frozen at "warn"
		// and `splitStreams=false`, so the per-test env stubs never
		// take effect.
		vi.resetModules();
	});

	afterEach(() => {
		Reflect.deleteProperty(process.env, "MAESTRO_LOG_JSON");
		Reflect.deleteProperty(process.env, "MAESTRO_LOG_LEVEL");
		Reflect.deleteProperty(process.env, "MAESTRO_LOG_SPLIT_STREAMS");
		vi.restoreAllMocks();
		vi.resetModules();
	});

	it("routes debug and info logs to stdout when split streams are enabled", async () => {
		process.env.MAESTRO_LOG_LEVEL = "debug";
		process.env.MAESTRO_LOG_SPLIT_STREAMS = "1";
		const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

		const { createLogger } = await import("../../src/utils/logger.js");
		const logger = createLogger("logger-test");

		logger.info("migration started");
		logger.warn("migration slow");

		expect(stdout).toHaveBeenCalledWith(
			expect.stringContaining("[INFO] migration started"),
		);
		expect(stderr).toHaveBeenCalledWith(
			expect.stringContaining("[WARN] migration slow"),
		);
	});

	it("adds Cloud Logging severity to JSON log entries", async () => {
		process.env.MAESTRO_LOG_JSON = "1";
		process.env.MAESTRO_LOG_LEVEL = "info";
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

		const { createLogger } = await import("../../src/utils/logger.js");
		const logger = createLogger("logger-test");

		logger.info("migration started");

		expect(stderr).toHaveBeenCalledTimes(1);
		const entry = JSON.parse(String(stderr.mock.calls[0]?.[0]));
		expect(entry).toMatchObject({
			level: "info",
			severity: "INFO",
			message: "migration started",
			context: { module: "logger-test" },
		});
	});

	it("keeps warning logs observable by late console spies", async () => {
		const { createLogger } = await import("../../src/utils/logger.js");
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		const logger = createLogger("logger-test");

		logger.warn("configuration missing");

		expect(stderr).toHaveBeenCalledWith(
			expect.stringContaining("[WARN] configuration missing"),
		);
	});

	it("substrate: injecting RuntimeEnv directly skips the env-stub dance", async () => {
		// This is what the substrate buys: no vi.stubEnv, no vi.resetModules,
		// no module-cache reset. The test names the config it wants and the
		// unit under test honors it.
		const { createRuntimeEnv } = await import("../../src/runtime/env.js");
		const { Logger } = await import("../../src/utils/logger.js");
		const env = createRuntimeEnv({
			MAESTRO_LOG_LEVEL: "debug",
			MAESTRO_LOG_SPLIT_STREAMS: "1",
		});
		const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

		const logger = new Logger(undefined, () => env);
		logger.info("substrate works");
		logger.warn("substrate works");

		expect(stdout).toHaveBeenCalledWith(
			expect.stringContaining("[INFO] substrate works"),
		);
		expect(stderr).toHaveBeenCalledWith(
			expect.stringContaining("[WARN] substrate works"),
		);
	});
});

describe("logger env restore setup", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("populates the default RuntimeEnv cache from one test", async () => {
		process.env.MAESTRO_LOG_LEVEL = "warn";
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		const { createLogger } = await import("../../src/utils/logger.js");

		createLogger("logger-test").warn("first test");

		expect(stderr).toHaveBeenCalledWith(
			expect.stringContaining("[WARN] first test"),
		);
	});

	it("rebuilds the default RuntimeEnv after restore-env resets process.env", async () => {
		process.env.MAESTRO_LOG_LEVEL = "debug";
		process.env.MAESTRO_LOG_SPLIT_STREAMS = "1";
		const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		const { createLogger } = await import("../../src/utils/logger.js");

		createLogger("logger-test").info("second test");

		expect(stdout).toHaveBeenCalledWith(
			expect.stringContaining("[INFO] second test"),
		);
		expect(stderr).not.toHaveBeenCalled();
	});
});
