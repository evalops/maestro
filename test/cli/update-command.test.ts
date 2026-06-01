import { afterEach, describe, expect, it, vi } from "vitest";
import { handleUpdateCommand } from "../../src/cli/commands/update.js";

describe("handleUpdateCommand", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = undefined;
	});

	it("checks for updates without installing", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const attemptStartupUpdateImpl = vi.fn();

		await handleUpdateCommand(["--check", "--json"], {
			attemptStartupUpdateImpl,
			checkForUpdateImpl: async () => ({
				currentVersion: "0.10.0",
				latestVersion: "0.10.1",
				isUpdateAvailable: true,
				sourceUrl:
					"https://storage.googleapis.com/example/maestro/version.json",
			}),
			currentVersion: "0.10.0",
		});

		expect(attemptStartupUpdateImpl).not.toHaveBeenCalled();
		expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toMatchObject({
			status: "available",
			currentVersion: "0.10.0",
			latestVersion: "0.10.1",
		});
	});

	it("uses the startup updater without restarting for manual installs", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const attemptStartupUpdateImpl = vi.fn().mockResolvedValue({
			status: "updated",
			check: {
				currentVersion: "0.10.0",
				latestVersion: "0.10.1",
				isUpdateAvailable: true,
				sourceUrl:
					"https://storage.googleapis.com/example/maestro/version.json",
			},
		});

		await handleUpdateCommand([], {
			attemptStartupUpdateImpl,
			currentVersion: "0.10.0",
			env: {
				CI: "true",
				MAESTRO_SKIP_STARTUP_UPDATE: "1",
				MAESTRO_STARTUP_UPDATE: "off",
			},
		});

		expect(attemptStartupUpdateImpl).toHaveBeenCalledWith(
			expect.objectContaining({
				args: [],
				currentVersion: "0.10.0",
				isTty: true,
				restart: false,
			}),
		);
		expect(attemptStartupUpdateImpl.mock.calls[0]?.[0].env).toMatchObject({
			MAESTRO_STARTUP_UPDATE_RETRY_MS: "0",
		});
		expect(attemptStartupUpdateImpl.mock.calls[0]?.[0].env).not.toHaveProperty(
			"CI",
		);
		expect(attemptStartupUpdateImpl.mock.calls[0]?.[0].env).not.toHaveProperty(
			"MAESTRO_SKIP_STARTUP_UPDATE",
		);
		expect(log.mock.calls[0]?.[0]).toContain("Updated Maestro to 0.10.1");
	});
});
