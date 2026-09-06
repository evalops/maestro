#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isPublicDocumentationPath } from "./public-documentation-boundary.mjs";

const forbiddenPaths = [
	".github/public-release-mirror.exclude",
	"scripts/check-public-mirror-drift.mjs",
	"scripts/prepare-public-release-mirror.mjs",
	".github/BUGBOT.md",
	".github/PUBLIC_TREE_MIRROR_BOUNDARY.md",
	".github/RELEASE_MIRROR_CONTRACT.md",
	"CLAUDE.md",
];

const forbiddenPathPrefixes = [
	".agents/",
	".context/",
	".github/public-repo/",
];

const scanExcludedDirectories = new Set([
	".git",
	".next",
	".nx",
	"build",
	"dist",
	"node_modules",
	"target",
	"tmp",
]);

function read(path) {
	return readFileSync(resolve(path), "utf8");
}

function filesystemFiles(root = ".") {
	const files = [];
	function walk(relativeDirectory) {
		for (const entry of readdirSync(resolve(relativeDirectory), {
			withFileTypes: true,
		})) {
			const relativePath = relativeDirectory === "."
				? entry.name
				: `${relativeDirectory}/${entry.name}`;
			if (entry.isDirectory()) {
				if (!scanExcludedDirectories.has(entry.name)) {
					walk(relativePath);
				}
				continue;
			}
			if (entry.isFile()) files.push(relativePath);
		}
	}
	walk(root);
	return files;
}

function documentationErrors() {
	const errors = [];
	for (const path of filesystemFiles()) {
		if (forbiddenPathPrefixes.some((prefix) => path.startsWith(prefix))) {
			errors.push(`${path} must not exist in the public source tree.`);
		}
		if (path.startsWith("docs/") && !isPublicDocumentationPath(path)) {
			errors.push(`${path} is not approved public documentation.`);
		}
	}
	return errors;
}

function documentationAllowlistErrors() {
	const path = "docs/doc-path-allowlist.json";
	if (!existsSync(resolve(path))) return [];
	let entries;
	try {
		entries = JSON.parse(read(path));
	} catch (error) {
		return [`${path} is invalid JSON: ${error.message}`];
	}
	if (!Array.isArray(entries)) {
		return [`${path} must contain a JSON array`];
	}
	return entries
		.filter(
			(entry) =>
				!entry
				|| typeof entry.source !== "string"
				|| !existsSync(resolve(entry.source)),
		)
		.map(
			(entry) =>
				`${path} references unavailable source ${JSON.stringify(entry?.source ?? null)}`,
		);
}

const errors = [];
const packageJson = JSON.parse(read("package.json"));
for (const [name, command] of Object.entries(packageJson?.scripts ?? {})) {
	if (name === "scenario" || name.startsWith("scenario:")) {
		errors.push(`package.json exposes a non-public scenario script: ${name}`);
	}
	if (String(command).includes("scripts/internal/")) {
		errors.push(`package.json script ${name} references an unavailable script.`);
	}
}

for (const path of forbiddenPaths) {
	if (existsSync(resolve(path))) {
		errors.push(`${path} must not exist in the public source tree.`);
	}
}
errors.push(...documentationErrors(), ...documentationAllowlistErrors());

if (errors.length > 0) {
	console.error("Public surface boundary check failed:");
	for (const error of errors) console.error(`- ${error}`);
	process.exit(1);
}

console.log("Public surface boundary check passed.");
