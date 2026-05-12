#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const requiredMirrorExcludes = [
	"docs/internal/**",
	"evals/internal/**",
	"scripts/internal/**",
	"test/internal/**",
];

const forbiddenPublicPaths = [
	"docs/protocols/complex-task-scenarios.md",
	"evals/scenarios/complex-task-gauntlet.json",
	"test/scenario-pack.test.ts",
];

function read(path) {
	return readFileSync(resolve(path), "utf8");
}

function fail(errors) {
	console.error("Public surface boundary check failed:");
	for (const error of errors) {
		console.error(`- ${error}`);
	}
	process.exit(1);
}

const errors = [];
const packageJson = JSON.parse(read("package.json"));
const scripts = packageJson?.scripts ?? {};

for (const [name, command] of Object.entries(scripts)) {
	if (name === "scenario" || name.startsWith("scenario:")) {
		errors.push(`package.json exposes internal scenario script: ${name}`);
	}
	if (String(command).includes("scripts/internal/")) {
		errors.push(`package.json script ${name} references scripts/internal/`);
	}
}

const mirrorExcludePath = ".github/public-release-mirror.exclude";
if (existsSync(resolve(mirrorExcludePath))) {
	const mirrorExclude = read(mirrorExcludePath);
	for (const pattern of requiredMirrorExcludes) {
		if (!mirrorExclude.split(/\r?\n/u).includes(pattern)) {
			errors.push(`${mirrorExcludePath} is missing ${pattern}`);
		}
	}
}

for (const path of forbiddenPublicPaths) {
	if (existsSync(resolve(path))) {
		errors.push(`${path} must not exist in the mirrored public source tree.`);
	}
}

if (errors.length > 0) {
	fail(errors);
}

console.log("Public surface boundary check passed.");
