#!/usr/bin/env node
// @ts-check

import {
	getWorkspacePackages,
	loadRootPackage,
} from "./workspace-utils.js";
import { getRuntimeWorkspaceNames } from "./runtime-workspaces.mjs";
import { isDirectCliEntrypoint } from "./direct-cli-entrypoint.mjs";

const dependencySections = [
	"dependencies",
	"optionalDependencies",
	"peerDependencies",
];

export function collectPublicPackageDependencyReport({
	rootPackage,
	workspacePackages,
	runtimeWorkspaceNames,
}) {
	const rootName =
		typeof rootPackage?.name === "string" ? rootPackage.name : "root";

	if (rootPackage?.private === true) {
		return {
			rootName,
			skipped: true,
			privateWorkspaceDependencies: [],
			runtimeWorkspaceDependencies: [],
		};
	}

	const privateWorkspaceNames = new Set(
		workspacePackages
			.filter((workspacePackage) => workspacePackage.data.private === true)
			.map((workspacePackage) => workspacePackage.name),
	);
	const runtimeWorkspaceNameSet = new Set(runtimeWorkspaceNames);
	const offenders = [];
	const runtimeDependencyOffenders = [];

	for (const section of dependencySections) {
		const deps = rootPackage?.[section];
		if (!deps || typeof deps !== "object" || Array.isArray(deps)) {
			continue;
		}
		for (const name of Object.keys(deps)) {
			if (privateWorkspaceNames.has(name)) {
				offenders.push(`${section}.${name}`);
			}
			if (!runtimeWorkspaceNameSet.has(name)) {
				continue;
			}
			runtimeDependencyOffenders.push(`${section}.${name}`);
		}
	}

	return {
		rootName,
		skipped: false,
		privateWorkspaceDependencies: offenders.sort(),
		runtimeWorkspaceDependencies: runtimeDependencyOffenders.sort(),
	};
}

export async function buildPublicPackageDependencyReport({
	rootPackage = loadRootPackage(),
	loadWorkspacePackages = getWorkspacePackages,
	resolveRuntimeWorkspaceNames = getRuntimeWorkspaceNames,
} = {}) {
	if (rootPackage?.private === true) {
		return collectPublicPackageDependencyReport({
			rootPackage,
			workspacePackages: [],
			runtimeWorkspaceNames: [],
		});
	}
	return collectPublicPackageDependencyReport({
		rootPackage,
		workspacePackages: await loadWorkspacePackages(rootPackage),
		runtimeWorkspaceNames: resolveRuntimeWorkspaceNames(rootPackage),
	});
}

function reportHasPrivateWorkspaceDependencies(report) {
	return report.privateWorkspaceDependencies.length > 0;
}

function reportHasRuntimeWorkspaceDependencies(report) {
	return report.runtimeWorkspaceDependencies.length > 0;
}

async function main() {
	const report = await buildPublicPackageDependencyReport();

	if (report.skipped) {
		console.log(
			`${report.rootName} is private; public package dependency check skipped.`,
		);
		return;
	}

	if (reportHasPrivateWorkspaceDependencies(report)) {
		console.error(
			`${report.rootName} is public but references private workspace packages:`,
		);
		for (const offender of report.privateWorkspaceDependencies) {
			console.error(`- ${offender}`);
		}
		console.error(
			"Publish the workspace package first or vendor the narrow client into the public package.",
		);
		process.exit(1);
	}

	if (reportHasRuntimeWorkspaceDependencies(report)) {
		console.error(
			`${report.rootName} is public but declares vendored runtime workspace packages as install-time dependencies:`,
		);
		for (const offender of report.runtimeWorkspaceDependencies) {
			console.error(`- ${offender}`);
		}
		console.error(
			"Keep runtime workspace packages vendored under dist/node_modules only so package managers do not resolve them from the registry.",
		);
		process.exit(1);
	}

	console.log(
		`${report.rootName} does not reference forbidden workspace package dependency metadata.`,
	);
}

if (isDirectCliEntrypoint(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
