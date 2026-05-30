import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	attemptStartupUpdate,
	isInstalledPackageEntrypoint,
} from "../../src/update/startup-refresh.js";

const installedArgv = [
	"/usr/local/bin/node",
	"/usr/local/lib/node_modules/@evalops/maestro/dist/cli.js",
];

describe("isInstalledPackageEntrypoint", () => {
	it("recognizes npm-installed package entrypoints", () => {
		expect(
			isInstalledPackageEntrypoint(
				"/usr/local/lib/node_modules/@evalops/maestro/dist/cli.js",
				"@evalops/maestro",
			),
		).toBe(true);
		expect(
			isInstalledPackageEntrypoint(
				"/Users/me/Projects/maestro/dist/cli.js",
				"@evalops/maestro",
			),
		).toBe(false);
	});

	it("recognizes npm bin shims that resolve to installed package entrypoints", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-entrypoint-"));
		try {
			const cliPath = join(
				dir,
				"lib",
				"node_modules",
				"@evalops",
				"maestro",
				"dist",
				"cli.js",
			);
			mkdirSync(dirname(cliPath), { recursive: true });
			writeFileSync(cliPath, "#!/usr/bin/env node\n", "utf8");

			const shimPath = join(dir, "bin", "maestro");
			mkdirSync(dirname(shimPath), { recursive: true });
			symlinkSync(cliPath, shimPath);

			expect(isInstalledPackageEntrypoint(shimPath, "@evalops/maestro")).toBe(
				true,
			);
		} finally {
			rmSync(dir, { force: true, recursive: true });
		}
	});
});

describe("attemptStartupUpdate", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { force: true, recursive: true });
		}
	});

	const statePath = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-startup-update-"));
		tempDirs.push(dir);
		return join(dir, "state.json");
	};

	it("skips non-installed entrypoints before checking the network", async () => {
		const checkForUpdateImpl = vi.fn();
		const outcome = await attemptStartupUpdate({
			argv: ["/usr/local/bin/node", "/Users/me/Projects/maestro/dist/cli.js"],
			currentVersion: "0.10.0",
			env: {},
			isTty: true,
			checkForUpdateImpl,
		});
		expect(outcome.status).toBe("skipped");
		expect(checkForUpdateImpl).not.toHaveBeenCalled();
	});

	it("installs and restarts when a newer version is available", async () => {
		const installPackage = vi.fn().mockReturnValue({ status: 0 });
		const restart = vi.fn().mockReturnValue({ status: 7 });
		const outcome = await attemptStartupUpdate({
			argv: installedArgv,
			currentVersion: "0.10.0",
			env: {},
			isTty: true,
			statePath: statePath(),
			checkForUpdateImpl: async () => ({
				currentVersion: "0.10.0",
				latestVersion: "0.10.1",
				isUpdateAvailable: true,
				sourceUrl:
					"https://storage.googleapis.com/example/maestro/version.json",
			}),
			installPackage,
			restart,
		});
		expect(installPackage).toHaveBeenCalledWith("@evalops/maestro", "0.10.1");
		expect(restart).toHaveBeenCalled();
		expect(outcome).toMatchObject({ status: "restarted", exitCode: 7 });
	});

	it("does not install in check-only mode", async () => {
		const installPackage = vi.fn();
		const outcome = await attemptStartupUpdate({
			argv: installedArgv,
			currentVersion: "0.10.0",
			env: { MAESTRO_STARTUP_UPDATE: "check" },
			isTty: true,
			checkForUpdateImpl: async () => ({
				currentVersion: "0.10.0",
				latestVersion: "0.10.1",
				isUpdateAvailable: true,
				sourceUrl:
					"https://storage.googleapis.com/example/maestro/version.json",
			}),
			installPackage,
		});
		expect(outcome.status).toBe("available");
		expect(installPackage).not.toHaveBeenCalled();
	});

	it("refuses non-semver install metadata", async () => {
		const installPackage = vi.fn();
		const outcome = await attemptStartupUpdate({
			argv: installedArgv,
			currentVersion: "0.10.0",
			env: {},
			isTty: true,
			checkForUpdateImpl: async () => ({
				currentVersion: "0.10.0",
				latestVersion: "latest",
				isUpdateAvailable: true,
				sourceUrl:
					"https://storage.googleapis.com/example/maestro/version.json",
			}),
			installPackage,
		});
		expect(outcome.status).toBe("failed");
		expect(installPackage).not.toHaveBeenCalled();
	});

	it("throttles repeated failed install attempts for the same version", async () => {
		const path = statePath();
		const checkForUpdateImpl = vi.fn().mockResolvedValue({
			currentVersion: "0.10.0",
			latestVersion: "0.10.1",
			isUpdateAvailable: true,
			sourceUrl: "https://storage.googleapis.com/example/maestro/version.json",
		});
		const installPackage = vi.fn().mockReturnValue({ status: 1 });

		const first = await attemptStartupUpdate({
			argv: installedArgv,
			currentVersion: "0.10.0",
			env: {},
			isTty: true,
			now: 1000,
			statePath: path,
			checkForUpdateImpl,
			installPackage,
		});
		const second = await attemptStartupUpdate({
			argv: installedArgv,
			currentVersion: "0.10.0",
			env: {},
			isTty: true,
			now: 2000,
			statePath: path,
			checkForUpdateImpl,
			installPackage,
		});

		expect(first.status).toBe("failed");
		expect(second.status).toBe("available");
		expect(installPackage).toHaveBeenCalledTimes(1);
	});
});
