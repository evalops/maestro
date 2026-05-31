import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPackageName } from "../../src/package-metadata.js";
import {
	attemptStartupUpdate,
	isInstalledPackageEntrypoint,
} from "../../src/update/startup-refresh.js";

const packageName = getPackageName();
const installedArgv = [
	"/usr/local/bin/node",
	`/usr/local/lib/node_modules/${packageName}/dist/cli.js`,
];
const globalPrefix = "/usr/local";

describe("isInstalledPackageEntrypoint", () => {
	it("recognizes npm-installed package entrypoints", () => {
		expect(
			isInstalledPackageEntrypoint(
				`/usr/local/lib/node_modules/${packageName}/dist/cli.js`,
				packageName,
				globalPrefix,
			),
		).toBe(true);
		expect(
			isInstalledPackageEntrypoint(
				"/Users/me/Projects/maestro/dist/cli.js",
				packageName,
				globalPrefix,
			),
		).toBe(false);
	});

	it("rejects project and npx package entrypoints outside the npm global prefix", () => {
		expect(
			isInstalledPackageEntrypoint(
				`/Users/me/Projects/app/node_modules/${packageName}/dist/cli.js`,
				packageName,
				globalPrefix,
			),
		).toBe(false);
		expect(
			isInstalledPackageEntrypoint(
				`/Users/me/.npm/_npx/abc/node_modules/${packageName}/dist/cli.js`,
				packageName,
				globalPrefix,
			),
		).toBe(false);
	});

	it("recognizes Bun global package entrypoints", () => {
		expect(
			isInstalledPackageEntrypoint(
				`/Users/me/.bun/install/global/node_modules/${packageName}/dist/cli.js`,
				packageName,
				"/Users/me/.bun/install/global",
			),
		).toBe(true);
	});

	it("recognizes npm bin shims that resolve to installed package entrypoints", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-entrypoint-"));
		try {
			const cliPath = join(
				dir,
				"lib",
				"node_modules",
				...packageName.split("/"),
				"dist",
				"cli.js",
			);
			mkdirSync(dirname(cliPath), { recursive: true });
			writeFileSync(cliPath, "#!/usr/bin/env node\n", "utf8");

			const shimPath = join(dir, "bin", "maestro");
			mkdirSync(dirname(shimPath), { recursive: true });
			symlinkSync(cliPath, shimPath);

			expect(isInstalledPackageEntrypoint(shimPath, packageName, dir)).toBe(
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
			globalPrefix,
			isTty: true,
			checkForUpdateImpl,
		});
		expect(outcome.status).toBe("skipped");
		expect(checkForUpdateImpl).not.toHaveBeenCalled();
	});

	it("skips the manual update command before checking the network", async () => {
		const checkForUpdateImpl = vi.fn();
		const outcome = await attemptStartupUpdate({
			args: ["update"],
			argv: installedArgv,
			currentVersion: "0.10.0",
			env: {},
			globalPrefix,
			isTty: true,
			checkForUpdateImpl,
		});
		expect(outcome).toMatchObject({
			status: "skipped",
			reason: "manual update command",
		});
		expect(checkForUpdateImpl).not.toHaveBeenCalled();
	});

	it("skips single-shot prompt invocations before checking the network", async () => {
		const checkForUpdateImpl = vi.fn();
		const outcome = await attemptStartupUpdate({
			args: ["audit this repo"],
			argv: installedArgv,
			currentVersion: "0.10.0",
			env: {},
			globalPrefix,
			isTty: true,
			checkForUpdateImpl,
		});
		expect(outcome).toMatchObject({
			status: "skipped",
			reason: "single-shot prompt",
		});
		expect(checkForUpdateImpl).not.toHaveBeenCalled();
	});

	it("skips exec invocations before checking the network", async () => {
		const checkForUpdateImpl = vi.fn();
		const outcome = await attemptStartupUpdate({
			args: ["exec", "audit this repo"],
			argv: installedArgv,
			currentVersion: "0.10.0",
			env: {},
			globalPrefix,
			isTty: true,
			checkForUpdateImpl,
		});
		expect(outcome).toMatchObject({
			status: "skipped",
			reason: "non-interactive command",
		});
		expect(checkForUpdateImpl).not.toHaveBeenCalled();
	});

	it("skips when the running package is outside the npm global prefix", async () => {
		const checkForUpdateImpl = vi.fn();
		const outcome = await attemptStartupUpdate({
			argv: [
				"/usr/local/bin/node",
				`/Users/me/app/node_modules/${packageName}/dist/cli.js`,
			],
			currentVersion: "0.10.0",
			env: {},
			globalPrefix,
			isTty: true,
			checkForUpdateImpl,
		});
		expect(outcome.status).toBe("skipped");
		expect(checkForUpdateImpl).not.toHaveBeenCalled();
	});

	it("skips when the npm global prefix cannot be resolved", async () => {
		const checkForUpdateImpl = vi.fn();
		const outcome = await attemptStartupUpdate({
			argv: installedArgv,
			currentVersion: "0.10.0",
			env: {},
			globalPrefix: null,
			isTty: true,
			checkForUpdateImpl,
		});
		expect(outcome).toMatchObject({
			status: "skipped",
			reason: "npm global prefix unavailable",
		});
		expect(checkForUpdateImpl).not.toHaveBeenCalled();
	});

	it("uses a bounded startup update check timeout while preserving fallback sources", async () => {
		const checkForUpdateImpl = vi.fn().mockResolvedValue({
			currentVersion: "0.10.0",
			latestVersion: "0.10.0",
			isUpdateAvailable: false,
			sourceUrl: "https://storage.googleapis.com/example/maestro/version.json",
		});
		const outcome = await attemptStartupUpdate({
			argv: installedArgv,
			checkTimeoutMs: 120,
			currentVersion: "0.10.0",
			env: {
				MAESTRO_UPDATE_URLS: "https://example.com/a,https://example.com/b",
			},
			globalPrefix,
			isTty: true,
			checkForUpdateImpl,
		});
		expect(outcome.status).toBe("current");
		expect(checkForUpdateImpl).toHaveBeenCalledWith("0.10.0", {
			timeoutMs: 60,
			urls: ["https://example.com/a", "https://example.com/b"],
		});
	});

	it("infers global install context from npm entrypoints before checking updates", async () => {
		const checkForUpdateImpl = vi.fn().mockResolvedValue({
			currentVersion: "0.10.0",
			latestVersion: "0.10.0",
			isUpdateAvailable: false,
			sourceUrl: "https://storage.googleapis.com/example/maestro/version.json",
		});
		const outcome = await attemptStartupUpdate({
			argv: installedArgv,
			currentVersion: "0.10.0",
			env: {},
			isTty: true,
			checkForUpdateImpl,
		});
		expect(outcome.status).toBe("current");
		expect(checkForUpdateImpl).toHaveBeenCalledTimes(1);
	});

	it("installs and restarts when a newer version is available", async () => {
		const installPackage = vi.fn().mockReturnValue({ status: 0 });
		const restart = vi.fn().mockReturnValue({ status: 7 });
		const outcome = await attemptStartupUpdate({
			argv: installedArgv,
			currentVersion: "0.10.0",
			env: {},
			globalPrefix,
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
		expect(installPackage).toHaveBeenCalledWith("npm", packageName, "0.10.1");
		expect(restart).toHaveBeenCalled();
		expect(outcome).toMatchObject({ status: "restarted", exitCode: 7 });
	});

	it("uses Bun to update Bun global installs", async () => {
		const installPackage = vi.fn().mockReturnValue({ status: 0 });
		const outcome = await attemptStartupUpdate({
			argv: [
				"/usr/local/bin/node",
				`/Users/me/.bun/install/global/node_modules/${packageName}/dist/cli.js`,
			],
			currentVersion: "0.10.0",
			env: {},
			globalInstallContexts: [
				{
					packageManager: "bun",
					prefix: "/Users/me/.bun/install/global",
				},
			],
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
			restart: false,
		});
		expect(installPackage).toHaveBeenCalledWith("bun", packageName, "0.10.1");
		expect(outcome).toMatchObject({ status: "updated" });
	});

	it("can install without restarting for manual update commands", async () => {
		const installPackage = vi.fn().mockReturnValue({ status: 0 });
		const restart = vi.fn();
		const outcome = await attemptStartupUpdate({
			argv: installedArgv,
			currentVersion: "0.10.0",
			env: {},
			globalPrefix,
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
			restart: false,
		});
		expect(installPackage).toHaveBeenCalledWith("npm", packageName, "0.10.1");
		expect(restart).not.toHaveBeenCalled();
		expect(outcome).toMatchObject({ status: "updated" });
	});

	it("sanitizes package manager environment during automatic fallback installs", async () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-startup-install-env-"));
		tempDirs.push(dir);
		const binDir = join(dir, "bin");
		mkdirSync(binDir, { recursive: true });
		const envLog = join(dir, "env.log");
		const npmShim = join(binDir, "npm");
		writeFileSync(
			npmShim,
			`#!/bin/sh
env > "${envLog}"
exit 0
`,
			"utf8",
		);
		chmodSync(npmShim, 0o755);

		const outcome = await attemptStartupUpdate({
			argv: installedArgv,
			currentVersion: "0.10.0",
			env: {
				PATH: `${binDir}:${process.env.PATH ?? ""}`,
				MAESTRO_STARTUP_UPDATE_RETRY_MS: "0",
				MAESTRO_STARTUP_UPDATE_STATE: join(dir, "untrusted-state.json"),
				MAESTRO_UPDATE_URL: "https://attacker.invalid/version.json",
				MAESTRO_UPDATE_URLS: "https://attacker.invalid/a.json",
				NODE_AUTH_TOKEN: "secret-token",
				NODE_OPTIONS: "--require=attacker",
				NPM_CONFIG_REGISTRY: "https://attacker.invalid/npm/",
				npm_config_userconfig: join(dir, "attacker.npmrc"),
				BUN_CONFIG_REGISTRY: "https://attacker.invalid/bun/",
			},
			globalPrefix,
			isTty: true,
			statePath: statePath(),
			checkForUpdateImpl: async () => ({
				currentVersion: "0.10.0",
				latestVersion: "0.10.1",
				isUpdateAvailable: true,
				sourceUrl:
					"https://storage.googleapis.com/example/maestro/version.json",
			}),
			restart: false,
		});

		expect(outcome.status).toBe("updated");
		const installedEnv = readFileSync(envLog, "utf8");
		expect(installedEnv).toContain(`PATH=${binDir}:`);
		expect(installedEnv).toContain(`NPM_CONFIG_PREFIX=${globalPrefix}`);
		expect(installedEnv).not.toContain("MAESTRO_STARTUP_UPDATE_STATE=");
		expect(installedEnv).not.toContain("MAESTRO_UPDATE_URL=");
		expect(installedEnv).not.toContain("MAESTRO_UPDATE_URLS=");
		expect(installedEnv).not.toContain("NODE_AUTH_TOKEN=");
		expect(installedEnv).not.toContain("NODE_OPTIONS=");
		expect(installedEnv).not.toContain("NPM_CONFIG_REGISTRY=");
		expect(installedEnv).not.toContain("npm_config_userconfig=");
		expect(installedEnv).not.toContain("BUN_CONFIG_REGISTRY=");
	});

	it("does not install in check-only mode", async () => {
		const installPackage = vi.fn();
		const outcome = await attemptStartupUpdate({
			argv: installedArgv,
			currentVersion: "0.10.0",
			env: { MAESTRO_STARTUP_UPDATE: "check" },
			globalPrefix,
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
			globalPrefix,
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
			globalPrefix,
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
			globalPrefix,
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
