#!/usr/bin/env node
// @ts-check

import { execFileSync } from "node:child_process";
import { getPackageMetadata } from "./package-metadata.js";

function parseArgs(argv) {
	/** @type {{range: string; packageName: string; message: string; otp: string; dryRun: boolean; replacementPackage: string}} */
	const options = {
		range: "",
		packageName: "",
		message: "",
		otp: "",
		dryRun: false,
		replacementPackage: "",
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--range":
				options.range = argv[++index] ?? "";
				break;
			case "--package":
				options.packageName = argv[++index] ?? "";
				break;
			case "--message":
				options.message = argv[++index] ?? "";
				break;
			case "--otp":
				options.otp = argv[++index] ?? "";
				break;
			case "--replacement-package":
				options.replacementPackage = argv[++index] ?? "";
				break;
			case "--dry-run":
				options.dryRun = true;
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	return options;
}

const { name, canonicalPackageName } = getPackageMetadata();
const options = parseArgs(process.argv.slice(2));

if (!options.range) {
	console.error(
		"Usage: node scripts/deprecate-release.js --range <version-or-range> [--package <name>] [--message <text>] [--replacement-package <name>] [--otp <code>] [--dry-run]",
	);
	process.exit(1);
}

const packageName = options.packageName || name;
const replacementPackage =
	options.replacementPackage ||
	(packageName === canonicalPackageName ? "" : canonicalPackageName);
const defaultMessage = replacementPackage
	? `Deprecated package path. Install ${replacementPackage} instead.`
	: "Deprecated release. Upgrade to a supported Maestro version.";
const message = options.message || defaultMessage;
const spec = `${packageName}@${options.range}`;
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npmArgs = ["deprecate", spec, message];

if (options.otp) {
	npmArgs.push("--otp", options.otp);
}

if (options.dryRun) {
	console.log(`[dry-run] ${npmCommand} ${npmArgs.join(" ")}`);
	process.exit(0);
}

execFileSync(npmCommand, npmArgs, { stdio: "inherit" });
console.log(`Deprecated ${spec}`);
