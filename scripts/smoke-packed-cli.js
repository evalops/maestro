#!/usr/bin/env node
// @ts-check

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getRuntimeWorkspaceNames } from "./runtime-workspaces.mjs";
import {
	assertInstallablePackageMetadata,
	getBunCommand,
	getNpmCommand,
	readInstalledPackageJson,
	runInstalledCliSmoke,
	runInstalledPackageAudit,
} from "./install-smoke-utils.js";
import { getPackageMetadata } from "./package-metadata.js";
import {
	getWorkspacePackages,
	loadRootPackage,
} from "./workspace-utils.js";

const tarballArg = process.argv[2];
if (!tarballArg) {
	console.error("Usage: node scripts/smoke-packed-cli.js <path-to-tarball>");
	process.exit(1);
}

const tarballPath = resolve(process.cwd(), tarballArg);
const tarballSizeBytes = statSync(tarballPath).size;
const maxTarballSizeBytes = Number.parseInt(
	process.env.MAESTRO_MAX_PACK_SIZE_BYTES ?? `${10 * 1024 * 1024}`,
	10,
);

if (!Number.isFinite(maxTarballSizeBytes) || maxTarballSizeBytes <= 0) {
	console.error("MAESTRO_MAX_PACK_SIZE_BYTES must be a positive integer");
	process.exit(1);
}

if (tarballSizeBytes > maxTarballSizeBytes) {
	console.error(
		`Tarball ${tarballPath} is ${tarballSizeBytes} bytes, exceeding limit ${maxTarballSizeBytes}.`,
	);
	process.exit(1);
}

const rootPackage = loadRootPackage();
const { name, version, cliCommand } = getPackageMetadata();
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

function assertInstalledMetadata(installRoot, label) {
	const installedPackage = readInstalledPackageJson(name, installRoot);
	assertInstallablePackageMetadata(installedPackage, {
		label,
		forbiddenWorkspaceNames,
	});
}

function runNpmInstallSmoke() {
	const tempDir = mkdtempSync(join(tmpdir(), "maestro-pack-smoke-npm-"));
	try {
		execFileSync(npmCommand, ["init", "-y"], {
			cwd: tempDir,
			stdio: "ignore",
		});
		execFileSync(npmCommand, ["install", tarballPath], {
			cwd: tempDir,
			stdio: "inherit",
		});
		assertInstalledMetadata(tempDir, `${tarballPath} via npm`);
		runInstalledPackageAudit(tempDir, {
			label: tarballPath,
		});
		runInstalledCliSmoke(tempDir, {
			cliCommand,
			expectedVersion: version,
			label: "npm-installed packed CLI",
		});

		console.log(
			`Smoke-tested ${cliCommand} from ${tarballPath} with npm (${tarballSizeBytes} bytes).`,
		);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

function runBunInstallSmoke() {
	if (process.env.MAESTRO_SKIP_BUN_INSTALL_SMOKE === "1") {
		console.log(`Skipping Bun packed install smoke for ${tarballPath}.`);
		return;
	}

	const tempDir = mkdtempSync(join(tmpdir(), "maestro-pack-smoke-bun-"));
	try {
		execFileSync(bunCommand, ["init", "-y"], {
			cwd: tempDir,
			stdio: "ignore",
		});
		execFileSync(bunCommand, ["add", tarballPath], {
			cwd: tempDir,
			stdio: "inherit",
		});
		assertInstalledMetadata(tempDir, `${tarballPath} via Bun`);
		runInstalledCliSmoke(tempDir, {
			cliCommand,
			expectedVersion: version,
			label: "Bun-installed packed CLI",
		});

		console.log(
			`Smoke-tested ${cliCommand} from ${tarballPath} with Bun (${tarballSizeBytes} bytes).`,
		);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

runNpmInstallSmoke();
runBunInstallSmoke();
