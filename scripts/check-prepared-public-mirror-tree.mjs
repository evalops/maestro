#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

function parseArgs(argv) {
	const args = {
		target: "",
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--target":
				args.target = argv[++index] ?? "";
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

function fail(message) {
	console.error(message);
	process.exit(1);
}

const options = parseArgs(process.argv.slice(2));
const targetRoot = resolve(options.target);

if (!existsSync(targetRoot)) {
	fail(`Prepared public mirror target does not exist: ${targetRoot}`);
}

if (existsSync(resolve(targetRoot, ".github/public-release-mirror.exclude"))) {
	fail(".github/public-release-mirror.exclude must not exist in the prepared public mirror tree.");
}

const boundaryScript = resolve(
	targetRoot,
	"scripts/check-public-surface-boundary.mjs",
);
if (!existsSync(boundaryScript)) {
	fail(`Missing public surface boundary checker in prepared public mirror tree: ${boundaryScript}`);
}

const result = spawnSync(process.execPath, [boundaryScript], {
	cwd: targetRoot,
	encoding: "utf8",
});

if (result.stdout) {
	process.stdout.write(result.stdout);
}
if (result.stderr) {
	process.stderr.write(result.stderr);
}

if (result.status !== 0) {
	fail(`Public surface boundary smoke failed with exit code ${result.status ?? "unknown"}.`);
}

console.log("Prepared public mirror tree smoke passed.");
