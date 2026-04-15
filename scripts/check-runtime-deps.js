#!/usr/bin/env node
// @ts-check

import { builtinModules } from "node:module";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { globSync } from "glob";
import { loadRootPackage } from "./workspace-utils.js";

const rootPackage = loadRootPackage();
const allowedPackages = new Set([
	...Object.keys(rootPackage.dependencies ?? {}),
	...Object.keys(rootPackage.optionalDependencies ?? {}),
	...Object.keys(rootPackage.peerDependencies ?? {}),
	...((Array.isArray(rootPackage.bundleDependencies)
		? rootPackage.bundleDependencies
		: []) ?? []),
]);
const builtinPackageNames = new Set(
	builtinModules.flatMap((name) =>
		name.startsWith("node:") ? [name, name.slice(5)] : [name, `node:${name}`],
	),
);

const distFiles = globSync("dist/**/*.js", {
	cwd: process.cwd(),
	nodir: true,
});

if (distFiles.length === 0) {
	console.error("No built JavaScript files found in dist/. Run npm run build first.");
	process.exit(1);
}

/**
 * @param {string} specifier
 */
function isInternalSpecifier(specifier) {
	return (
		specifier.startsWith(".") ||
		specifier.startsWith("/") ||
		specifier.startsWith("file:") ||
		specifier.startsWith("data:")
	);
}

/**
 * @param {string} specifier
 */
function getPackageName(specifier) {
	if (specifier.startsWith("@")) {
		const [scope, name] = specifier.split("/", 3);
		return scope && name ? `${scope}/${name}` : specifier;
	}
	const [name] = specifier.split("/", 2);
	return name ?? specifier;
}

/**
 * @param {string} code
 */
function stripComments(code) {
	return code
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "");
}

/**
 * @param {string} code
 */
function extractSpecifiers(code) {
	const specifiers = new Set();
	const normalizedCode = stripComments(code);
	const patterns = [
		/^\s*import\s+type\s+[^\n"'`]*?\sfrom\s+["'`]([^"'`]+)["'`]/gm,
		/^\s*import\s+[^\n"'`]*?\sfrom\s+["'`]([^"'`]+)["'`]/gm,
		/^\s*import\s+["'`]([^"'`]+)["'`]/gm,
		/^\s*export\s+[^\n"'`]*?\sfrom\s+["'`]([^"'`]+)["'`]/gm,
		/import\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
		/require\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
	];

	for (const pattern of patterns) {
		let match;
		while ((match = pattern.exec(normalizedCode)) !== null) {
			const specifier = match[1];
			if (specifier) {
				specifiers.add(specifier);
			}
		}
	}

	return specifiers;
}

/** @type {Map<string, Set<string>>} */
const missingPackages = new Map();

for (const file of distFiles) {
	const code = readFileSync(file, "utf-8");
	for (const specifier of extractSpecifiers(code)) {
		if (isInternalSpecifier(specifier) || builtinPackageNames.has(specifier)) {
			continue;
		}
		if (specifier === "bun" || specifier.startsWith("bun:")) {
			continue;
		}

		const packageName = getPackageName(specifier);
		if (allowedPackages.has(packageName)) {
			continue;
		}

		let occurrences = missingPackages.get(packageName);
		if (!occurrences) {
			occurrences = new Set();
			missingPackages.set(packageName, occurrences);
		}
		occurrences.add(relative(process.cwd(), file));
	}
}

if (missingPackages.size > 0) {
	console.error("Missing runtime dependencies referenced by built dist/:");
	for (const [packageName, files] of [...missingPackages.entries()].sort()) {
		const examples = [...files].sort().slice(0, 3).join(", ");
		console.error(`- ${packageName} (e.g. ${examples})`);
	}
	process.exit(1);
}

console.log(
	`Verified runtime dependencies for ${distFiles.length} built JavaScript files.`,
);
