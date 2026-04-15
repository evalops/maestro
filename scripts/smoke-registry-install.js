#!/usr/bin/env node
// @ts-check

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPackageMetadata } from "./package-metadata.js";

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
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const maxAttempts = Number.parseInt(
	process.env.MAESTRO_REGISTRY_POLL_ATTEMPTS ?? "24",
	10,
);
const pollDelayMs = Number.parseInt(
	process.env.MAESTRO_REGISTRY_POLL_DELAY_MS ?? "5000",
	10,
);

function sleep(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
}

await main();
