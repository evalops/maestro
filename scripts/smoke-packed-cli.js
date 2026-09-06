#!/usr/bin/env node
// @ts-check

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getRuntimeWorkspaceNames } from "./runtime-workspaces.mjs";
import {
	assertInstallablePackageMetadata,
	getNpmCommand,
	readInstalledPackageJson,
	runInstalledCliSmoke,
	runInstalledNativeCliSmoke,
	runInstalledPackageAudit,
} from "./install-smoke-utils.js";
import { getPackageMetadata } from "./package-metadata.js";
import { loadRootPackage } from "./workspace-utils.js";

const tarballArg = process.argv[2];
if (!tarballArg) {
	console.error("Usage: node scripts/smoke-packed-cli.js <path-to-tarball>");
	process.exit(1);
}

const tarballPath = resolve(process.cwd(), tarballArg);
const tarballSizeBytes = statSync(tarballPath).size;
const maxTarballSizeBytes = Number.parseInt(
	process.env.MAESTRO_MAX_PACK_SIZE_BYTES ?? `${100 * 1024 * 1024}`,
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
const forbiddenWorkspaceNames = getRuntimeWorkspaceNames(rootPackage);
const npmCommand = getNpmCommand();

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
		if (process.env.MAESTRO_REQUIRE_PACKAGED_TUI === "1") {
			runInstalledNativeCliSmoke(tempDir, { cliCommand });
		}

		console.log(
			`Smoke-tested ${cliCommand} from ${tarballPath} with npm (${tarballSizeBytes} bytes).`,
		);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

runNpmInstallSmoke();
