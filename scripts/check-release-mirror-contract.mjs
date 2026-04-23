#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const manifestPath = ".github/release-mirror-manifest.json";
const contractPath = ".github/RELEASE_MIRROR_CONTRACT.md";

const requiredCommandSuiteFiles = [
	"src/cli-tui/commands/command-catalog.ts",
	"src/cli-tui/commands/command-registry-adapter.ts",
	"src/cli-tui/commands/command-suite-catalog.ts",
	"src/cli-tui/commands/command-suite-handlers.ts",
	"src/cli-tui/commands/access-command.ts",
	"src/cli-tui/commands/audit-command.ts",
	"src/cli-tui/commands/hotkeys-command.ts",
	"src/cli-tui/commands/limits-command.ts",
	"src/cli-tui/commands/pii-command.ts",
	"src/cli-tui/commands/registry.ts",
	"src/cli-tui/commands/subcommands/auth-commands.ts",
	"src/cli-tui/commands/subcommands/config-commands.ts",
	"src/cli-tui/commands/subcommands/diag-commands.ts",
	"src/cli-tui/commands/subcommands/git-commands.ts",
	"src/cli-tui/commands/subcommands/index.ts",
	"src/cli-tui/commands/subcommands/safety-commands.ts",
	"src/cli-tui/commands/subcommands/session-commands.ts",
	"src/cli-tui/commands/subcommands/tools-commands.ts",
	"src/cli-tui/commands/subcommands/ui-commands.ts",
	"src/cli-tui/commands/subcommands/undo-commands.ts",
	"src/cli-tui/commands/subcommands/usage-commands.ts",
	"src/cli-tui/commands/subcommands/utils.ts",
	"src/cli-tui/commands/types.ts",
	"src/cli-tui/tui-renderer/command-registry-options.ts",
	"src/cli-tui/tui-renderer/command-suite-wiring.ts",
];

const forbiddenExactFiles = [
	"src/cli-tui/tui-renderer.ts",
	"src/cli-tui/commands/grouped-command-handlers.ts",
	"src/cli-tui/tui-renderer/grouped-handlers-wiring.ts",
];

const forbiddenPrefixes = ["src/cli-tui/commands/grouped/"];

function fail(errors) {
	console.error("Release mirror contract check failed:");
	for (const error of errors) {
		console.error(`- ${error}`);
	}
	process.exit(1);
}

function readManifest() {
	try {
		return JSON.parse(readFileSync(resolve(manifestPath), "utf8"));
	} catch (error) {
		throw new Error(
			`Unable to read ${manifestPath}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

function isRepoRelativePath(path) {
	return (
		path.length > 0 &&
		!path.startsWith("/") &&
		!path.includes("\\") &&
		!path.split("/").includes("..")
	);
}

const errors = [];

if (!existsSync(resolve(contractPath))) {
	errors.push(`Missing ${contractPath}.`);
}

let manifest;
try {
	manifest = readManifest();
} catch (error) {
	fail([error instanceof Error ? error.message : String(error)]);
}

if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
	errors.push(`${manifestPath} must contain a JSON object.`);
}

const files = Array.isArray(manifest?.files) ? manifest.files : null;
if (!files) {
	errors.push(`${manifestPath} must contain a files array.`);
}

const seen = new Set();
for (const [index, file] of (files ?? []).entries()) {
	if (typeof file !== "string") {
		errors.push(`files[${index}] must be a string.`);
		continue;
	}

	if (!isRepoRelativePath(file)) {
		errors.push(`Mirrored file must be a repo-relative path: ${file}`);
	}

	if (seen.has(file)) {
		errors.push(`Duplicate mirrored file: ${file}`);
	}
	seen.add(file);

	if (!existsSync(resolve(file))) {
		errors.push(`Mirrored source file does not exist: ${file}`);
	}
}

for (const file of forbiddenExactFiles) {
	if (seen.has(file)) {
		errors.push(
			`${file} is internal-only; split shared code before mirroring it.`,
		);
	}
}

for (const file of seen) {
	for (const prefix of forbiddenPrefixes) {
		if (file.startsWith(prefix)) {
			errors.push(
				`${file} is under an internal-only grouped-command surface.`,
			);
		}
	}
}

const hasCommandSuiteRuntime = [...seen].some(
	(file) =>
		file === "src/cli-tui/commands/command-suite-handlers.ts" ||
		file.startsWith("src/cli-tui/commands/subcommands/"),
);

if (hasCommandSuiteRuntime) {
	for (const file of requiredCommandSuiteFiles) {
		if (!seen.has(file)) {
			errors.push(`Missing command-suite mirror file: ${file}`);
		}
	}
}

if (errors.length > 0) {
	fail(errors);
}

console.log("Release mirror contract is valid.");
