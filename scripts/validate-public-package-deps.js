#!/usr/bin/env node
// @ts-check

import {
	getWorkspacePackages,
	loadRootPackage,
} from "./workspace-utils.js";
import { getRuntimeWorkspaceNames } from "./runtime-workspaces.mjs";

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
const runtimeWorkspaceNames = new Set(getRuntimeWorkspaceNames(rootPackage));

const dependencySections = [
	"dependencies",
	"optionalDependencies",
	"peerDependencies",
];

const offenders = [];
const runtimeDependencyOffenders = [];

for (const section of dependencySections) {
	const deps = rootPackage[section];
	if (!deps || typeof deps !== "object" || Array.isArray(deps)) {
		continue;
	}
	for (const name of Object.keys(deps)) {
		if (privateWorkspaceNames.has(name)) {
			offenders.push(`${section}.${name}`);
		}
		if (!runtimeWorkspaceNames.has(name)) {
			continue;
		}
		runtimeDependencyOffenders.push(`${section}.${name}`);
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

if (runtimeDependencyOffenders.length > 0) {
	console.error(
		`${rootName} is public but declares vendored runtime workspace packages as install-time dependencies:`,
	);
	for (const offender of runtimeDependencyOffenders.sort()) {
		console.error(`- ${offender}`);
	}
	console.error(
		"Keep runtime workspace packages vendored under dist/node_modules only so package managers do not resolve them from the registry.",
	);
	process.exit(1);
}

console.log(
	`${rootName} does not reference forbidden workspace package dependency metadata.`,
);
