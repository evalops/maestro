#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

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

function toPosixPath(path) {
	return path.split(sep).join("/");
}

export function collectFormattedPublicMirrorTargets(targetRoot) {
	const targets = [];
	const rootPackageJson = resolve(targetRoot, "package.json");
	if (existsSync(rootPackageJson)) {
		targets.push("package.json");
	}
	const openapiJson = resolve(targetRoot, "openapi.json");
	if (existsSync(openapiJson)) {
		targets.push("openapi.json");
	}
	const packagesRoot = resolve(targetRoot, "packages");
	if (existsSync(packagesRoot)) {
		for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) {
				continue;
			}
			const packageJson = resolve(packagesRoot, entry.name, "package.json");
			if (existsSync(packageJson)) {
				targets.push(toPosixPath(relative(targetRoot, packageJson)));
			}
		}
	}
	return targets.sort();
}

export function preparedPublicMirrorGuardrailCommands(targetRoot) {
	const formattedTargets = collectFormattedPublicMirrorTargets(targetRoot);
	const vitestRunner = resolve(targetRoot, "scripts/run-vitest.js");
	return [
		{
			args: ["@biomejs/biome@1.9.4", "check", ...formattedTargets],
			command: "bunx",
			label: "Biome generated package metadata check",
		},
		{
			args: [vitestRunner, "--run", "test/scripts/ci-guardrails.test.ts"],
			command: process.execPath,
			label: "Public CI guardrail tests",
		},
	];
}

function runCommand({ args, command, label }, cwd) {
	console.log(`\n## ${label}`);
	const result = spawnSync(command, args, {
		cwd,
		env: process.env,
		shell: process.platform === "win32",
		stdio: "inherit",
	});
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new Error(
			`${label} failed with exit code ${result.status ?? "unknown"}.`,
		);
	}
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const targetRoot = resolve(options.target);
	if (!existsSync(targetRoot)) {
		throw new Error(`Prepared public mirror target does not exist: ${targetRoot}`);
	}
	if (!existsSync(resolve(targetRoot, "test/scripts/ci-guardrails.test.ts"))) {
		throw new Error(
			"Prepared public mirror tree is missing test/scripts/ci-guardrails.test.ts.",
		);
	}
	if (!existsSync(resolve(targetRoot, "scripts/run-vitest.js"))) {
		throw new Error(
			"Prepared public mirror tree is missing scripts/run-vitest.js.",
		);
	}

	for (const command of preparedPublicMirrorGuardrailCommands(targetRoot)) {
		runCommand(command, targetRoot);
	}
	console.log("Prepared public mirror CI guardrails passed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
