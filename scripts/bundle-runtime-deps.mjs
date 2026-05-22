#!/usr/bin/env node

import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import { loadRootPackage } from "./workspace-utils.js";
import {
	getRuntimeWorkspaceNames,
	getRuntimeWorkspacePackages,
} from "./runtime-workspaces.mjs";

const bundledPackages = new Set(["@google/genai", "google-auth-library"]);
const entryPoints = [
	"dist/cli.js",
	"dist/agent/providers/google.js",
	"dist/agent/providers/google-gemini-cli.js",
	"dist/agent/providers/vertex.js",
];

const rootPackage = loadRootPackage();
const runtimeWorkspaceNames = new Set(getRuntimeWorkspaceNames(rootPackage));
const declaredPackages = new Set([
	...Object.keys(rootPackage.dependencies ?? {}),
	...Object.keys(rootPackage.optionalDependencies ?? {}),
	...Object.keys(rootPackage.peerDependencies ?? {}),
	...runtimeWorkspaceNames,
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

const runtimeWorkspacePackages = await getRuntimeWorkspacePackages(rootPackage);
for (const workspacePackage of runtimeWorkspacePackages) {
	const sourceDir = dirname(workspacePackage.path);
	const sourceDist = join(sourceDir, "dist");
	if (!existsSync(sourceDist)) {
		throw new Error(`Runtime workspace is missing dist output: ${sourceDist}`);
	}

	const targetDir = join("dist", "node_modules", ...workspacePackage.name.split("/"));
	rmSync(targetDir, { recursive: true, force: true });
	mkdirSync(targetDir, { recursive: true });
	cpSync(workspacePackage.path, join(targetDir, "package.json"));
	cpSync(sourceDist, join(targetDir, "dist"), { recursive: true });
	rmSync(join(targetDir, "dist", "testing"), { recursive: true, force: true });
}

chmodSync("dist/cli.js", 0o755);
