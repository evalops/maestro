import { describe, expect, it, vi } from "vitest";
import {
	checkMaestroTuiBinaryForWebServer,
	logMaestroTuiBootCheck,
} from "../../src/server/maestro-tui-boot-check.js";

describe("checkMaestroTuiBinaryForWebServer", () => {
	it("requires the binary when resolution fails", () => {
		const result = checkMaestroTuiBinaryForWebServer(
			{},
			{
				exists: () => false,
				findOnPath: () => undefined,
				packageRoot: "/tmp/no-maestro-root",
			},
		);
		expect(result.status).toBe("missing");
	});

	it("returns ok when a binary is resolvable", () => {
		const result = checkMaestroTuiBinaryForWebServer(
			{},
			{
				packageRoot: "/pkg",
				platform: "linux",
				arch: "x64",
				exists: (path) =>
					path === "/pkg/vendor/maestro-tui/linux-x64/maestro-tui",
				findOnPath: () => undefined,
			},
		);
		expect(result).toEqual({
			status: "ok",
			binary: "/pkg/vendor/maestro-tui/linux-x64/maestro-tui",
		});
	});

	it("returns missing when no candidate exists", () => {
		const result = checkMaestroTuiBinaryForWebServer(
			{},
			{
				packageRoot: "/pkg",
				platform: "linux",
				arch: "x64",
				exists: () => false,
				findOnPath: () => undefined,
			},
		);
		expect(result.status).toBe("missing");
		if (result.status !== "missing") return;
		expect(result.message).toContain("maestro-tui");
	});
});

describe("logMaestroTuiBootCheck", () => {
	it("is a no-op when the binary resolves", () => {
		const log = { warn: vi.fn(), error: vi.fn() };
		logMaestroTuiBootCheck({ status: "ok", binary: "/bin/maestro-tui" }, log);
		expect(log.warn).not.toHaveBeenCalled();
		expect(log.error).not.toHaveBeenCalled();
	});

	it("errors when missing (fail-closed)", () => {
		const log = { warn: vi.fn(), error: vi.fn() };
		logMaestroTuiBootCheck(
			{
				status: "missing",
				message: "Could not find the native maestro-tui binary",
			},
			log,
		);
		expect(log.error).toHaveBeenCalledOnce();
		expect(log.warn).not.toHaveBeenCalled();
		expect(String(log.error.mock.calls[0]?.[0])).toContain("not found");
		expect(String(log.error.mock.calls[0]?.[0])).toContain("install or build");
	});
});
