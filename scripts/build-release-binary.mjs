#!/usr/bin/env node
// @ts-check

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getPackageMetadata } from "./package-metadata.js";

const RELEASE_BINARY_TARGETS = new Map([
	[
		"linux-x64",
		{
			bunTarget: "bun-linux-x64-baseline",
			outfile: "dist/release/maestro-linux-x64",
		},
	],
	[
		"darwin-arm64",
		{
			bunTarget: "bun-darwin-arm64",
			outfile: "dist/release/maestro-darwin-arm64",
		},
	],
]);

function parseArgs(argv) {
	const options = {
		outfile: "",
		platform: "linux-x64",
		skipBuild: false,
		target: "",
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--outfile":
				options.outfile = argv[++index] ?? "";
				break;
			case "--platform":
				options.platform = argv[++index] ?? "";
				break;
			case "--skip-build":
				options.skipBuild = true;
				break;
			case "--target":
				options.target = argv[++index] ?? "";
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	return options;
}

const options = parseArgs(process.argv.slice(2));
const configuredTarget = RELEASE_BINARY_TARGETS.get(options.platform);
const bunTarget = options.target || configuredTarget?.bunTarget;
const outfile = options.outfile || configuredTarget?.outfile;

if (!bunTarget) {
	throw new Error(
		`Unsupported release binary platform: ${options.platform}. Expected one of: ${Array.from(
			RELEASE_BINARY_TARGETS.keys(),
		).join(", ")}`,
	);
}

if (!outfile) {
	throw new Error("Release binary outfile could not be resolved.");
}

if (!options.skipBuild) {
	execFileSync("npm", ["run", "build"], { stdio: "inherit" });
}

const resolvedOutfile = resolve(outfile);
const { version } = getPackageMetadata();
mkdirSync(dirname(resolvedOutfile), { recursive: true });

execFileSync(
	"bun",
	[
		"build",
		"./src/cli.ts",
		"--compile",
		`--target=${bunTarget}`,
		"--define",
		"MAESTRO_BUNDLE_RUNTIME=true",
		"--define",
		`MAESTRO_RELEASE_VERSION=${JSON.stringify(version)}`,
		"--external",
		"sharp",
		"--external",
		"tree-sitter",
		"--external",
		"tree-sitter-bash",
		`--outfile=${resolvedOutfile}`,
	],
	{ stdio: "inherit" },
);

chmodSync(resolvedOutfile, 0o755);
const size = statSync(resolvedOutfile).size;
console.log(
	`Built release binary ${resolvedOutfile} for ${bunTarget} (${size} bytes).`,
);
