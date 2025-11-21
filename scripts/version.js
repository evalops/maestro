#!/usr/bin/env node
/**
 * Version bumping script for Composer CLI
 * Usage:
 *   npm run version:patch
 *   npm run version:minor
 *   npm run version:major
 */

import {
	getRootPackagePath,
	getWorkspacePackages,
	loadRootPackage,
	syncInternalDependencies,
	verifyAlignedVersions,
	writePackageJson,
} from "./workspace-utils.js";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function bumpVersion(currentVersion, type) {
	const parts = currentVersion.split(".").map(Number);
	const [major, minor, patch] = parts;

	switch (type) {
		case "major":
			return `${major + 1}.0.0`;
		case "minor":
			return `${major}.${minor + 1}.0`;
		case "patch":
			return `${major}.${minor}.${patch + 1}`;
		default:
			throw new Error(`Invalid bump type: ${type}`);
	}
}

function updateChangelog(newVersion) {
	const changelogPath = join(process.cwd(), "CHANGELOG.md");
	try {
		const content = readFileSync(changelogPath, "utf-8");
		const date = new Date().toISOString().split("T")[0];
		const newEntry = `\n## [${newVersion}] - ${date}\n\n### Added\n\n### Changed\n\n### Fixed\n\n`;
		
		// Insert after the first heading
		const lines = content.split("\n");
		const insertIndex = lines.findIndex(line => line.startsWith("## "));
		
		if (insertIndex !== -1) {
			lines.splice(insertIndex, 0, newEntry);
			writeFileSync(changelogPath, lines.join("\n"));
			console.log(`📝 Updated CHANGELOG.md with ${newVersion}`);
		}
	} catch (error) {
		console.warn("⚠️  Could not update CHANGELOG.md:", error.message);
	}
}

function updatePackageLock(newVersion) {
	try {
		// Update package-lock.json
		execSync("npm install --package-lock-only", { stdio: "inherit" });
		console.log("📦 Updated package-lock.json");
	} catch (error) {
		const reason = error instanceof Error ? error.message : "unknown error";
		throw new Error(`Failed to update package-lock.json: ${reason}`);
	}
}

function restoreBackups(backups) {
	for (const backup of backups) {
		writePackageJson(backup.path, backup.original);
	}
}

function main() {
	const bumpType = process.argv[2];
	
	if (!bumpType || !["patch", "minor", "major"].includes(bumpType)) {
		console.error("Usage: node version.js <patch|minor|major>");
		process.exit(1);
	}

	const rootPkg = loadRootPackage();
	const workspacePkgs = getWorkspacePackages(rootPkg);
	const internalNames = new Set(workspacePkgs.map((pkg) => pkg.name));

	const currentVersion = rootPkg.version;
	const newVersion = bumpVersion(currentVersion, bumpType);

	console.log(`🔼 Bumping version: ${currentVersion} → ${newVersion}`);

	// Prepare updated package data (in-memory)
	rootPkg.version = newVersion;
	syncInternalDependencies(rootPkg, newVersion, internalNames);
	for (const pkg of workspacePkgs) {
		pkg.data.version = newVersion;
		syncInternalDependencies(pkg.data, newVersion, internalNames);
	}

	// Verify consistency
	verifyAlignedVersions(
		[...workspacePkgs, { name: rootPkg.name, data: rootPkg }],
		newVersion,
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
		console.log("✅ Updated package.json files");

		// Update changelog
		updateChangelog(newVersion);

		// Update package-lock.json
		updatePackageLock(newVersion);
	} catch (error) {
		console.error("⚠️  Version bump failed, restoring package.json files");
		restoreBackups(backups);
		throw error;
	}

	console.log(`\n✨ Version bumped to ${newVersion}`);
	console.log("\nNext steps:");
	console.log(`  1. Review CHANGELOG.md and add your changes`);
	console.log(`  2. git add .`);
	console.log(`  3. git commit -m "Release v${newVersion}"`);
	console.log(`  4. git tag v${newVersion}`);
	console.log(`  5. git push origin main --tags`);
	console.log(`  6. npm publish`);
}

main();
