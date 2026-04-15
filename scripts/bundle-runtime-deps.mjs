#!/usr/bin/env node

import { chmodSync } from "node:fs";
import { build } from "esbuild";
import { loadRootPackage } from "./workspace-utils.js";

const bundledPackages = new Set(["@google/genai", "google-auth-library"]);
const entryPoints = [
	"dist/cli.js",
	"dist/agent/providers/google.js",
	"dist/agent/providers/google-gemini-cli.js",
	"dist/agent/providers/vertex.js",
];

const rootPackage = loadRootPackage();
const declaredPackages = new Set([
	...Object.keys(rootPackage.dependencies ?? {}),
	...Object.keys(rootPackage.optionalDependencies ?? {}),
	...Object.keys(rootPackage.peerDependencies ?? {}),
	...((Array.isArray(rootPackage.bundleDependencies)
		? rootPackage.bundleDependencies
		: []) ?? []),
]);

const external = Array.from(declaredPackages)
	.filter((packageName) => !bundledPackages.has(packageName))
	.flatMap((packageName) => [packageName, `${packageName}/*`]);

for (const entryPoint of entryPoints) {
	await build({
		entryPoints: [entryPoint],
		outfile: entryPoint,
		allowOverwrite: true,
		banner: {
			js: 'import { createRequire as __bundleCreateRequire } from "node:module"; const require = __bundleCreateRequire(import.meta.url);',
		},
		bundle: true,
		external,
		format: "esm",
		legalComments: "none",
		logLevel: "silent",
		platform: "node",
		target: "node20",
	});
}

chmodSync("dist/cli.js", 0o755);
