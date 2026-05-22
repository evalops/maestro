#!/usr/bin/env node
// @ts-check

import {
	getWorkspacePackages,
	loadRootPackage,
} from "./workspace-utils.js";

const rootPackage = loadRootPackage();
const rootName = typeof rootPackage.name === "string" ? rootPackage.name : "root";

if (rootPackage.private === true) {
	console.log(`${rootName} is private; public package dependency check skipped.`);
	process.exit(0);
}

const workspacePackages = await getWorkspacePackages(rootPackage);
const workspaceNames = new Set(
	workspacePackages.map((workspacePackage) => workspacePackage.name),
);
const privateWorkspaceNames = new Set(
	workspacePackages
		.filter((workspacePackage) => workspacePackage.data.private === true)
		.map((workspacePackage) => workspacePackage.name),
);
const bundled = Array.isArray(rootPackage.bundleDependencies)
	? rootPackage.bundleDependencies
	: [];
const bundledWorkspaceNames = new Set(
	bundled.filter((name) => workspaceNames.has(name)),
);

const dependencySections = [
	"dependencies",
	"optionalDependencies",
	"peerDependencies",
];

const offenders = [];
const bundledDependencyOffenders = [];

for (const section of dependencySections) {
	const deps = rootPackage[section];
	if (!deps || typeof deps !== "object" || Array.isArray(deps)) {
		continue;
	}
	for (const name of Object.keys(deps)) {
		if (privateWorkspaceNames.has(name)) {
			offenders.push(`${section}.${name}`);
		}
		if (!bundledWorkspaceNames.has(name)) {
			continue;
		}
		bundledDependencyOffenders.push(`${section}.${name}`);
	}
}

if (offenders.length > 0) {
	console.error(
		`${rootName} is public but references private workspace packages:`,
	);
	for (const offender of offenders.sort()) {
		console.error(`- ${offender}`);
	}
	console.error(
		"Publish the workspace package first or vendor the narrow client into the public package.",
	);
	process.exit(1);
}

if (bundledDependencyOffenders.length > 0) {
	console.error(
		`${rootName} is public but declares bundled workspace packages as install-time dependencies:`,
	);
	for (const offender of bundledDependencyOffenders.sort()) {
		console.error(`- ${offender}`);
	}
	console.error(
		"Keep bundled workspace packages in bundleDependencies only so package managers do not resolve them from the registry; check-packed-bundled-workspaces verifies npm still packs them under node_modules.",
	);
	process.exit(1);
}

console.log(
	`${rootName} does not reference forbidden workspace package dependency metadata.`,
);
