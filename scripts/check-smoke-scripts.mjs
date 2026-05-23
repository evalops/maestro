#!/usr/bin/env node

import { build } from "esbuild";
import { existsSync } from "node:fs";

const entryPoints = process.argv
	.slice(2)
	.filter(Boolean)
	.map((entryPoint) =>
		entryPoint.startsWith(".") || entryPoint.startsWith("/")
			? entryPoint
			: `./${entryPoint}`,
	)
	.filter((entryPoint) => existsSync(entryPoint));

if (entryPoints.length === 0) {
	console.log("No smoke scripts to check.");
	process.exit(0);
}

for (const entryPoint of entryPoints) {
	await build({
		bundle: true,
		entryPoints: [entryPoint],
		external: ["tree-sitter", "tree-sitter-bash"],
		format: "esm",
		logLevel: "silent",
		packages: "external",
		platform: "node",
		target: "node20",
		write: false,
	});
}

console.log(`Checked ${entryPoints.length} smoke script(s).`);
