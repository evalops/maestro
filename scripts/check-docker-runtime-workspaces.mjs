#!/usr/bin/env node
// @ts-check

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { loadRootPackage } from "./workspace-utils.js";
import { getRuntimeWorkspaceNames } from "./runtime-workspaces.mjs";

const rootDir = process.cwd();
const dockerfilePath = join(rootDir, "Dockerfile");

if (!existsSync(dockerfilePath)) {
	console.error("Dockerfile not found.");
	process.exit(1);
}

/**
 * @param {string} path
 * @returns {Record<string, unknown>}
 */
function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
/**
 * @param {Record<string, unknown>} pkg
 */
function runtimeWorkspaceNames(pkg) {
	return new Set([
		...Object.keys(
				/** @type {Record<string, unknown>} */ (pkg.dependencies ?? {}),
			),
			...getRuntimeWorkspaceNames(pkg),
	]);
}

const rootPackage = loadRootPackage();
const runtimeNames = runtimeWorkspaceNames(rootPackage);
const packagesDir = join(rootDir, "packages");
const workspacePackages = new Map();

for (const dirName of readdirSync(packagesDir)) {
	const packagePath = join(packagesDir, dirName, "package.json");
	if (!existsSync(packagePath)) {
		continue;
	}
	const pkg = readJson(packagePath);
	if (typeof pkg.name === "string") {
		workspacePackages.set(pkg.name, { dirName, packagePath });
	}
}

const requiredRuntimeWorkspaces = [...runtimeNames]
	.filter((name) => workspacePackages.has(name))
	.sort();
const dockerfile = readFileSync(dockerfilePath, "utf8");
const runnerStage = dockerfile.match(/FROM\s+\$\{BUN_IMAGE\}\s+AS\s+runner[\s\S]*$/);

if (!runnerStage) {
	console.error("Dockerfile runner stage not found.");
	process.exit(1);
}

const missing = [];
const runnerCopyPairs = new Set();

for (const line of runnerStage[0].split(/\r?\n/)) {
	const trimmed = line.trim();
	const match = trimmed.match(
		/^COPY\s+(?:--from=\S+\s+)?(?<source>\S+)\s+(?<target>\S+)$/,
	);
	if (match?.groups) {
		runnerCopyPairs.add(`${match.groups.source}\0${match.groups.target}`);
	}
}

for (const name of requiredRuntimeWorkspaces) {
	const workspace = workspacePackages.get(name);
	if (!workspace) {
		continue;
	}

	for (const file of ["package.json", "dist"]) {
		const source = `/app/packages/${workspace.dirName}/${file}`;
		const target = `./packages/${workspace.dirName}/${file}`;
		if (!runnerCopyPairs.has(`${source}\0${target}`)) {
			missing.push(`${name}: missing runner COPY ${source} -> ${target}`);
		}
	}
}

if (missing.length > 0) {
	console.error(
		"Runtime workspace packages required by the Maestro CLI are not copied into the Docker runner image:",
	);
	for (const item of missing) {
		console.error(`- ${item}`);
	}
	console.error(
		"Add explicit runner-stage COPY lines so node_modules workspace symlinks resolve in production.",
	);
	process.exit(1);
}

console.log(
	`Verified Docker runner workspace copies for ${requiredRuntimeWorkspaces.length} runtime package(s): ${requiredRuntimeWorkspaces.join(", ")}`,
);
console.log(`Checked ${relative(rootDir, dockerfilePath)} runner stage.`);
