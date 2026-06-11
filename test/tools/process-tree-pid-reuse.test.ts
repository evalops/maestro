import type * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const existsSyncMock = vi.fn();
const readdirSyncMock = vi.fn();
const readFileSyncMock = vi.fn();
const loggerWarn = vi.fn();

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return {
		...actual,
		existsSync: existsSyncMock,
		readdirSync: readdirSyncMock,
		readFileSync: readFileSyncMock,
	};
});

vi.mock("../../src/utils/logger.js", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: loggerWarn,
		error: vi.fn(),
	}),
}));

const { killProcessTreeGracefully } = await import(
	"../../src/tools/process-tree.js"
);
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
	process,
	"platform",
);

function createLinuxStat(startTime: string): string {
	const fields = [
		"S",
		"1",
		"2",
		"3",
		"4",
		"5",
		"6",
		"7",
		"8",
		"9",
		"10",
		"11",
		"12",
		"13",
		"14",
		"15",
		"16",
		"17",
		"18",
		startTime,
	];
	return `123 (sleep) ${fields.join(" ")}`;
}

describe("killProcessTreeGracefully", () => {
	beforeEach(() => {
		Object.defineProperty(process, "platform", {
			configurable: true,
			value: "linux",
		});
	});

	afterEach(() => {
		if (originalPlatformDescriptor) {
			Object.defineProperty(process, "platform", originalPlatformDescriptor);
		}
		vi.restoreAllMocks();
		vi.clearAllMocks();
		existsSyncMock.mockReset();
		readdirSyncMock.mockReset();
		readFileSyncMock.mockReset();
	});

	it("does not report a skipped SIGKILL after pid reuse as failed", async () => {
		existsSyncMock.mockImplementation(
			(path) => path === "/proc" || path === "/proc/123/stat",
		);
		readdirSyncMock.mockReturnValue([]);
		readFileSyncMock
			.mockReturnValueOnce(createLinuxStat("100"))
			.mockReturnValueOnce(createLinuxStat("200"));

		const killSpy = vi
			.spyOn(process, "kill")
			.mockImplementation((_pid, _signal) => true);

		const result = await killProcessTreeGracefully(123, 0);

		expect(result).toEqual({
			killed: [123],
			failed: [],
		});
		expect(killSpy).toHaveBeenCalledWith(123, "SIGTERM");
		expect(killSpy).not.toHaveBeenCalledWith(123, "SIGKILL");
		expect(loggerWarn).toHaveBeenCalledWith(
			"Skipping SIGKILL because process identity changed",
			{ pid: 123 },
		);
		expect(loggerWarn).not.toHaveBeenCalledWith(
			"Some processes could not be killed",
			expect.anything(),
		);
	});

	it("falls back to SIGKILL when the live identity cannot be re-read", async () => {
		existsSyncMock.mockImplementation(
			(path) => path === "/proc" || path === "/proc/123/stat",
		);
		readdirSyncMock.mockReturnValue([]);
		readFileSyncMock
			.mockReturnValueOnce(createLinuxStat("100"))
			.mockImplementation(() => {
				throw new Error("temporary /proc read failure");
			});

		let isAlive = true;
		const killSpy = vi
			.spyOn(process, "kill")
			.mockImplementation((pid, signal) => {
				if (pid !== 123) {
					throw new Error(`unexpected pid ${pid}`);
				}
				if (signal === 0) {
					if (!isAlive) {
						throw new Error("ESRCH");
					}
					return true;
				}
				if (signal === "SIGKILL") {
					isAlive = false;
				}
				return true;
			});

		const result = await killProcessTreeGracefully(123, 0);

		expect(result).toEqual({
			killed: [123],
			failed: [],
		});
		expect(killSpy).toHaveBeenCalledWith(123, "SIGTERM");
		expect(killSpy).toHaveBeenCalledWith(123, "SIGKILL");
		expect(loggerWarn).not.toHaveBeenCalledWith(
			"Skipping SIGKILL because process identity changed",
			expect.anything(),
		);
	});

	it("falls back to SIGKILL when /proc becomes unavailable after SIGTERM", async () => {
		let procAvailable = true;
		existsSyncMock.mockImplementation((path) => {
			if (path === "/proc") {
				return procAvailable;
			}
			return procAvailable && path === "/proc/123/stat";
		});
		readdirSyncMock.mockReturnValue([]);
		readFileSyncMock.mockImplementationOnce(() => {
			procAvailable = false;
			return createLinuxStat("100");
		});

		let isAlive = true;
		const killSpy = vi
			.spyOn(process, "kill")
			.mockImplementation((pid, signal) => {
				if (pid !== 123) {
					throw new Error(`unexpected pid ${pid}`);
				}
				if (signal === 0) {
					if (!isAlive) {
						throw new Error("ESRCH");
					}
					return true;
				}
				if (signal === "SIGKILL") {
					isAlive = false;
				}
				return true;
			});

		const result = await killProcessTreeGracefully(123, 0);

		expect(result).toEqual({
			killed: [123],
			failed: [],
		});
		expect(killSpy).toHaveBeenCalledWith(123, "SIGTERM");
		expect(killSpy).toHaveBeenCalledWith(123, "SIGKILL");
		expect(loggerWarn).not.toHaveBeenCalledWith(
			"Skipping SIGKILL because process identity changed",
			expect.anything(),
		);
	});
});
