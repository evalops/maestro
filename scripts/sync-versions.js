#!/usr/bin/env node

/**
 * Syncs all workspace package versions and inter-dependencies to match the root version.
 * Keeps the monorepo in lockstep (similar to pi-mono).
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const ROOT_PACKAGE_PATH = join(process.cwd(), "package.json");
const PACKAGES_DIR = join(process.cwd(), "packages");

function readPackageJson(path) {
	const content = readFileSync(path, "utf-8");
	return JSON.parse(content);
}

function writePackageJson(path, pkg) {
	writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
}

function getWorkspacePackages() {
	const dirs = readdirSync(PACKAGES_DIR, { withFileTypes: true }).filter(
		(entry) => entry.isDirectory(),
	);

	return dirs.map((dirent) => {
		const path = join(PACKAGES_DIR, dirent.name, "package.json");
		const data = readPackageJson(path);
		return { name: data.name, path, data };
	});
}

function syncInternalDependencies(pkg, version, internalNames) {
	const setVersion = (section) => {
		if (!section) {
			return;
		}

		for (const dep of Object.keys(section)) {
			if (internalNames.has(dep)) {
				section[dep] = `^${version}`;
			}
		}
	};

	setVersion(pkg.dependencies);
	setVersion(pkg.devDependencies);
}

function updatePackageLock() {
	try {
		execSync("npm install --package-lock-only", { stdio: "inherit" });
		console.log("📦 Updated package-lock.json");
	} catch (error) {
		console.warn("⚠️  Could not update package-lock.json:", error.message);
	}
}

function main() {
	const rootPkg = readPackageJson(ROOT_PACKAGE_PATH);
	const workspacePkgs = getWorkspacePackages();
	const internalNames = new Set(workspacePkgs.map((pkg) => pkg.name));
	const targetVersion = rootPkg.version;

	console.log(`🔄 Syncing all packages to version ${targetVersion}`);

	// Root package
	syncInternalDependencies(rootPkg, targetVersion, internalNames);
	writePackageJson(ROOT_PACKAGE_PATH, rootPkg);

	// Workspace packages
	for (const pkg of workspacePkgs) {
		pkg.data.version = targetVersion;
		syncInternalDependencies(pkg.data, targetVersion, internalNames);
		writePackageJson(pkg.path, pkg.data);
	}

	updatePackageLock();

	console.log("✅ Workspace versions are in lockstep");
}

main();
