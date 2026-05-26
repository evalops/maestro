#!/usr/bin/env node
// @ts-check

import { spawn } from "node:child_process";
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
const npmCommand =
	process.env.MAESTRO_NPM_COMMAND?.trim() ||
	(process.platform === "win32" ? "npm.cmd" : "npm");
const npmArgs = ["deprecate", spec, message];

if (options.otp) {
	npmArgs.push("--otp", options.otp);
}

if (options.dryRun) {
	console.log(`[dry-run] ${npmCommand} ${npmArgs.join(" ")}`);
	process.exit(0);
}

function runNpmCommand(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: ["inherit", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (chunk) => {
			const text = chunk.toString();
			stdout += text;
			process.stdout.write(text);
		});
		child.stderr.on("data", (chunk) => {
			const text = chunk.toString();
			stderr += text;
			process.stderr.write(text);
		});
		child.on("error", reject);
		child.on("close", (status) => {
			resolve({ status: status ?? 1, stdout, stderr });
		});
	});
}
const result = await runNpmCommand(npmCommand, npmArgs);
if (result.status !== 0) {
	const output = `${result.stdout}\n${result.stderr}`;
	if (
		output.includes("E404") &&
		output.includes("could not be found or you do not have permission")
	) {
		console.error(
			[
				`npm could not deprecate ${spec}.`,
				`${spec} resolved during workflow preflight, so this usually means the configured npm token does not have publish/deprecate permission for ${packageName}.`,
				"Update the npm-release NPM_TOKEN secret to a token owned by a package maintainer, then rerun the deprecation workflow.",
			].join("\n"),
		);
	}
	process.exit(result.status ?? 1);
}
console.log(`Deprecated ${spec}`);
