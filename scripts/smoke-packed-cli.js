#!/usr/bin/env node
// @ts-check

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	getNpmCommand,
	getNpxCommand,
	runInstalledPackageAudit,
} from "./install-smoke-utils.js";
import { getPackageMetadata } from "./package-metadata.js";

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

const { version, cliCommand } = getPackageMetadata();
const tempDir = mkdtempSync(join(tmpdir(), "maestro-pack-smoke-"));
const npmCommand = getNpmCommand();
const npxCommand = getNpxCommand();

try {
	execFileSync(npmCommand, ["init", "-y"], {
		cwd: tempDir,
		stdio: "ignore",
	});
	execFileSync(npmCommand, ["install", tarballPath], {
		cwd: tempDir,
		stdio: "inherit",
	});
	runInstalledPackageAudit(tempDir, {
		label: tarballPath,
	});
	const output = execFileSync(npxCommand, [cliCommand, "--version"], {
		cwd: tempDir,
		encoding: "utf-8",
	});

	if (!output.includes(version)) {
		throw new Error(
			`Expected ${cliCommand} --version output to include ${version}, received: ${output.trim()}`,
		);
	}

	console.log(
		`Smoke-tested ${cliCommand} from ${tarballPath} (${tarballSizeBytes} bytes).`,
	);
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}
