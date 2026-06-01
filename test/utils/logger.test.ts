import { afterEach, describe, expect, it, vi } from "vitest";

describe("logger stream routing", () => {
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
});
