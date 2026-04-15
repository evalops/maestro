#!/usr/bin/env node

/**
 * Syncs all workspace package versions and inter-dependencies to match the root version.
 * Keeps the monorepo in lockstep (similar to pi-mono).
 */

import { execSync } from "node:child_process";
import {
	getRootPackagePath,
	getWorkspacePackages,
	loadRootPackage,
	readPackageJson,
	shouldManagePackageLock,
	syncInternalDependencies,
	verifyAlignedVersions,
	writePackageJson,
} from "./workspace-utils.js";

function main() {
	const rootPkg = loadRootPackage();
	const workspacePkgs = getWorkspacePackages(rootPkg);
	const internalNames = new Set(workspacePkgs.map((pkg) => pkg.name));
	const targetVersion = rootPkg.version;

	console.log(`🔄 Syncing all packages to version ${targetVersion}`);

	// Prepare versions in-memory
	syncInternalDependencies(rootPkg, targetVersion, internalNames);
	for (const pkg of workspacePkgs) {
		pkg.data.version = targetVersion;
		syncInternalDependencies(pkg.data, targetVersion, internalNames);
	}

	verifyAlignedVersions(
		[...workspacePkgs, { name: rootPkg.name, data: rootPkg }],
		targetVersion,
	);

	// Persist updates
	const backups = [
		{ path: getRootPackagePath(), original: loadRootPackage() },
		...workspacePkgs.map((pkg) => ({
			path: pkg.path,
			original: readPackageJson(pkg.path),
		})),
	];

	try {
		writePackageJson(getRootPackagePath(), rootPkg);
		for (const pkg of workspacePkgs) {
			writePackageJson(pkg.path, pkg.data);
		}

		if (shouldManagePackageLock(rootPkg)) {
			execSync("npm install --package-lock-only", { stdio: "inherit" });
			console.log("📦 Updated package-lock.json");
		} else {
			console.log("📦 Skipped package-lock.json update for workspace-only repo");
		}
	} catch (error) {
		console.error("⚠️  Version sync failed, restoring package.json files");
		for (const backup of backups) {
			writePackageJson(backup.path, backup.original);
		}
		const reason = error instanceof Error ? error.message : "unknown error";
		throw new Error(`Failed to update package-lock.json: ${reason}`);
	}

	console.log("✅ Workspace versions are in lockstep");
}

main();
