#!/usr/bin/env node
// @ts-check

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRuntimeWorkspaceNames } from "./runtime-workspaces.mjs";
import {
	assertInstallablePackageMetadata,
	getBunCommand,
	getNpmCommand,
	readInstalledPackageJson,
	runBunxCliSmoke,
	runInstalledCliSmoke,
	runInstalledPackageAudit,
	runNpxCliSmoke,
} from "./install-smoke-utils.js";
import { getPackageMetadata } from "./package-metadata.js";
import { runPublishedReplayE2E } from "./smoke-published-replay-e2e.js";
import {
	getWorkspacePackages,
	loadRootPackage,
} from "./workspace-utils.js";

function parseArgs(argv) {
	/** @type {{packageName: string; version: string; cliCommand: string}} */
	const options = {
		packageName: "",
		version: "",
		cliCommand: "",
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--package":
				options.packageName = argv[++index] ?? "";
				break;
			case "--version":
				options.version = argv[++index] ?? "";
				break;
			case "--cli-command":
				options.cliCommand = argv[++index] ?? "";
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	return options;
}

const defaults = getPackageMetadata();
const overrides = parseArgs(process.argv.slice(2));
const cliCommand = overrides.cliCommand || defaults.cliCommand;
const name = overrides.packageName || defaults.name;
const version = overrides.version || defaults.version;
const packageSpec = `${name}@${version}`;
const rootPackage = loadRootPackage();
const runtimeWorkspaceNames = getRuntimeWorkspaceNames(rootPackage);
const workspacePackages = await getWorkspacePackages(rootPackage);
const forbiddenWorkspaceNames = Array.from(
	new Set([
		...runtimeWorkspaceNames,
		...workspacePackages
			.filter((workspacePackage) => workspacePackage.data.private === true)
			.map((workspacePackage) => workspacePackage.name),
	]),
).sort();
const npmCommand = getNpmCommand();
const bunCommand = getBunCommand();
const maxAttempts = Number.parseInt(
	process.env.MAESTRO_REGISTRY_POLL_ATTEMPTS ?? "120",
	10,
);
const pollDelayMs = Number.parseInt(
	process.env.MAESTRO_REGISTRY_POLL_DELAY_MS ?? "5000",
	10,
);
const installAuditLevel = process.env.MAESTRO_INSTALL_AUDIT_LEVEL ?? "critical";

function sleep(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function shouldRunBunInstallSmoke() {
	if (process.env.MAESTRO_SKIP_BUN_INSTALL_SMOKE === "1") {
		console.log(`Skipping Bun install smoke for ${packageSpec}.`);
		return false;
	}

	return true;
}

function assertInstalledMetadata(installRoot, label) {
	const installedPackage = readInstalledPackageJson(name, installRoot);
	assertInstallablePackageMetadata(installedPackage, {
		label,
		forbiddenWorkspaceNames,
	});
}

async function waitForPackage() {
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			const publishedVersion = execFileSync(
				npmCommand,
				["view", packageSpec, "version", "--json"],
				{ encoding: "utf8" },
			)
				.trim()
				.replace(/^"|"$/g, "");
			if (publishedVersion === version) {
				console.log(`Registry resolved ${packageSpec} on attempt ${attempt}.`);
				return;
			}
			console.log(
				`Registry returned ${publishedVersion || "empty response"} for ${packageSpec}; waiting...`,
			);
		} catch (error) {
			const reason =
				error instanceof Error ? error.message : "unknown registry lookup error";
			console.log(
				`Attempt ${attempt}/${maxAttempts} could not resolve ${packageSpec}: ${reason}`,
			);
		}

		if (attempt < maxAttempts) {
			await sleep(pollDelayMs);
		}
	}

	throw new Error(`Timed out waiting for ${packageSpec} to become available on npm`);
}

async function main() {
	await waitForPackage();

	const tempDir = mkdtempSync(join(tmpdir(), "maestro-registry-smoke-"));
	try {
		execFileSync(npmCommand, ["init", "-y"], {
			cwd: tempDir,
			stdio: "ignore",
		});
		execFileSync(npmCommand, ["install", packageSpec], {
			cwd: tempDir,
			stdio: "inherit",
		});
		assertInstalledMetadata(tempDir, `${packageSpec} via npm`);
		runInstalledPackageAudit(tempDir, {
			auditLevel: installAuditLevel,
			label: packageSpec,
		});
		runInstalledCliSmoke(tempDir, {
			cliCommand,
			expectedVersion: version,
			label: "npm-installed registry CLI",
		});
		runNpxCliSmoke(tempDir, {
			cliCommand,
			expectedVersion: version,
			label: "npx registry CLI",
		});
		await runPublishedReplayE2E({
			cliCommand,
			installRoot: tempDir,
			packageSpec,
		});

		console.log(`Smoke-tested ${packageSpec} from npm.`);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}

	if (!shouldRunBunInstallSmoke()) {
		return;
	}

	const bunTempDir = mkdtempSync(join(tmpdir(), "maestro-bun-registry-smoke-"));
	try {
		execFileSync(bunCommand, ["init", "-y"], {
			cwd: bunTempDir,
			stdio: "ignore",
		});
		execFileSync(bunCommand, ["add", packageSpec], {
			cwd: bunTempDir,
			stdio: "inherit",
		});
		assertInstalledMetadata(bunTempDir, `${packageSpec} via Bun`);
		runInstalledCliSmoke(bunTempDir, {
			cliCommand,
			expectedVersion: version,
			label: "Bun-installed registry CLI",
		});
		runBunxCliSmoke(bunTempDir, {
			cliCommand,
			expectedVersion: version,
			label: "bunx registry CLI",
		});
		await runPublishedReplayE2E({
			cliCommand,
			installRoot: bunTempDir,
			packageSpec,
		});

		console.log(`Smoke-tested ${packageSpec} from Bun.`);
	} finally {
		rmSync(bunTempDir, { recursive: true, force: true });
	}
}

await main();
