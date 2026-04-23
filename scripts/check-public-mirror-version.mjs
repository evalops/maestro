#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function parseArgs(argv) {
	const args = {
		allowRollback: false,
		source: process.cwd(),
		target: "",
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--allow-rollback":
				args.allowRollback = true;
				break;
			case "--source":
				args.source = argv[++index] ?? args.source;
				break;
			case "--target":
				args.target = argv[++index] ?? args.target;
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (!args.target) {
		throw new Error("Missing required --target <path>");
	}

	return args;
}

function readPackageVersion(root) {
	const packagePath = resolve(root, "package.json");
	if (!existsSync(packagePath)) {
		throw new Error(`Missing package.json: ${packagePath}`);
	}

	const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
	if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) {
		throw new Error(`package.json must contain an object: ${packagePath}`);
	}

	if (typeof pkg.version !== "string" || !pkg.version.trim()) {
		throw new Error(`package.json is missing a version: ${packagePath}`);
	}

	return pkg.version.trim();
}

function parseSemver(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version);
	if (!match) {
		throw new Error(`Unsupported semver version: ${version}`);
	}
	return match.slice(1, 4).map((part) => Number.parseInt(part, 10));
}

function compareSemver(left, right) {
	const a = parseSemver(left);
	const b = parseSemver(right);
	for (let index = 0; index < 3; index += 1) {
		if (a[index] !== b[index]) {
			return a[index] - b[index];
		}
	}
	return 0;
}

const options = parseArgs(process.argv.slice(2));
const sourceVersion = readPackageVersion(options.source);
const targetVersion = readPackageVersion(options.target);
const comparison = compareSemver(sourceVersion, targetVersion);

if (comparison < 0 && !options.allowRollback) {
	console.error(
		`Refusing to mirror internal version ${sourceVersion} over newer public version ${targetVersion}.`,
	);
	console.error(
		"Update the internal source version first, or pass --allow-rollback for an intentional recovery rollback.",
	);
	process.exit(1);
}

if (comparison < 0) {
	console.warn(
		`Allowing public mirror rollback from ${targetVersion} to ${sourceVersion}.`,
	);
} else {
	console.log(
		`Public mirror version check passed: internal ${sourceVersion}, public ${targetVersion}.`,
	);
}
