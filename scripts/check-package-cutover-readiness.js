#!/usr/bin/env node
// @ts-check

import { readFileSync } from "node:fs";
import { globSync } from "glob";
import { getPackageMetadata } from "./package-metadata.js";

const { packageAliases } = getPackageMetadata();
const aliasMatchers = packageAliases.map((alias) => ({
	alias,
	pattern: new RegExp(`(^|[^\\w/-])${escapeRegExp(alias)}(?![-\\w/])`, "m"),
}));

const allowedFiles = new Set(
	[
		"CHANGELOG.md",
		"README.md",
		"SECURITY.md",
		"docs/TOOLS_REFERENCE.md",
		"docs/release-ops.md",
		"package.json",
		"package-lock.json",
		"packages/jetbrains-plugin/README.md",
		"packages/jetbrains-plugin/src/main/resources/META-INF/plugin.xml",
		"scripts/check-package-cutover-readiness.js",
		"scripts/package-metadata.js",
		"scripts/sync-package-metadata.js",
		"src/agent/types.ts",
		"src/package-metadata.ts",
	]
		.filter(Boolean)
		.map((file) => file.replaceAll("\\", "/")),
);

const ignoredPatterns = [
	"**/.git/**",
	"**/.nx/**",
	"**/coverage/**",
	"**/dist/**",
	"**/node_modules/**",
	"**/tmp/**",
	"bun.lockb",
	"**/*.png",
	"**/*.jpg",
	"**/*.jpeg",
	"**/*.gif",
	"**/*.ico",
	"**/*.pdf",
	"**/*.woff",
	"**/*.woff2",
	"**/*.ttf",
];

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const offenders = [];

for (const file of globSync("**/*", {
	dot: true,
	nodir: true,
	ignore: ignoredPatterns,
})) {
	const normalizedFile = file.replaceAll("\\", "/");
	if (allowedFiles.has(normalizedFile)) {
		continue;
	}

	let content;
	try {
		content = readFileSync(file, "utf8");
	} catch {
		continue;
	}

	const matches = aliasMatchers
		.filter(({ pattern }) => pattern.test(content))
		.map(({ alias }) => alias);
	if (matches.length === 0) {
		continue;
	}

	offenders.push({ file: normalizedFile, matches });
}

if (offenders.length > 0) {
	console.error("Unexpected hard-coded root package references found:");
	for (const offender of offenders) {
		console.error(`- ${offender.file}: ${offender.matches.join(", ")}`);
	}
	process.exit(1);
}

console.log("Package cutover references are scoped to approved files.");
