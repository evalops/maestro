#!/usr/bin/env node
// @ts-check

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getNpmCommand,
	getNpxCommand,
	runInstalledPackageAudit,
} from "./install-smoke-utils.js";
import { getPackageMetadata } from "./package-metadata.js";

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function asStringArray(value) {
	return Array.isArray(value)
		? value.filter((entry) => typeof entry === "string" && entry.length > 0)
		: [];
}

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
const npmCommand = getNpmCommand();
const npxCommand = getNpxCommand();
const bunCommand = process.platform === "win32" ? "bun.exe" : "bun";
const maxAttempts = Number.parseInt(
	process.env.MAESTRO_REGISTRY_POLL_ATTEMPTS ?? "120",
	10,
);
const pollDelayMs = Number.parseInt(
	process.env.MAESTRO_REGISTRY_POLL_DELAY_MS ?? "5000",
	10,
);

function sleep(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function installedPackageJsonPath(packageName, installRoot) {
	return join(
		installRoot,
		"node_modules",
		...packageName.split("/"),
		"package.json",
	);
}

function readInstalledBundledDependencies(installRoot) {
	const packageJsonPath = installedPackageJsonPath(name, installRoot);
	try {
		const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("installed package.json did not contain an object");
		}
		return asStringArray(
			parsed.bundleDependencies ?? parsed.bundledDependencies,
		);
	} catch (error) {
		const reason =
			error instanceof Error ? error.message : "unknown package read error";
		throw new Error(
			`Could not read installed package metadata at ${packageJsonPath}: ${reason}`,
		);
	}
}

function shouldRunBunInstallSmoke(bundledDependencies) {
	if (process.env.MAESTRO_SKIP_BUN_INSTALL_SMOKE === "1") {
		console.log(`Skipping Bun install smoke for ${packageSpec}.`);
		return false;
	}

	if (process.env.MAESTRO_FORCE_BUN_INSTALL_SMOKE === "1") {
		return true;
	}

	if (bundledDependencies.length > 0) {
		console.log(
			`Skipping Bun install smoke for ${packageSpec}; package bundles ${bundledDependencies.join(
				", ",
			)}, and the npm install smoke already verified the published tarball contents.`,
		);
		return false;
	}

	return true;
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

	let installedBundledDependencies = [];
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
		installedBundledDependencies = readInstalledBundledDependencies(tempDir);
		runInstalledPackageAudit(tempDir, {
			label: packageSpec,
		});

		const versionOutput = execFileSync(npxCommand, [cliCommand, "--version"], {
			cwd: tempDir,
			encoding: "utf8",
		});
		if (!versionOutput.includes(version)) {
			throw new Error(
				`Expected ${cliCommand} --version output to include ${version}, received: ${versionOutput.trim()}`,
			);
		}

		execFileSync(npxCommand, [cliCommand, "--help"], {
			cwd: tempDir,
			stdio: "ignore",
		});

		console.log(`Smoke-tested ${packageSpec} from npm.`);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}

	if (!shouldRunBunInstallSmoke(installedBundledDependencies)) {
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

		const binPath =
			process.platform === "win32"
				? join(bunTempDir, "node_modules", ".bin", `${cliCommand}.cmd`)
				: join(bunTempDir, "node_modules", ".bin", cliCommand);
		const versionOutput = execFileSync(binPath, ["--version"], {
			cwd: bunTempDir,
			encoding: "utf8",
		});
		if (!versionOutput.includes(version)) {
			throw new Error(
				`Expected Bun-installed ${cliCommand} --version output to include ${version}, received: ${versionOutput.trim()}`,
			);
		}

		console.log(`Smoke-tested ${packageSpec} from Bun.`);
	} finally {
		rmSync(bunTempDir, { recursive: true, force: true });
	}
}

await main();
