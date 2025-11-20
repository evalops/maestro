#!/usr/bin/env node
/**
 * Version bumping script for Composer CLI
 * Usage:
 *   npm run version:patch
 *   npm run version:minor
 *   npm run version:major
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const PACKAGE_JSON_PATH = join(process.cwd(), "package.json");
const PACKAGES_DIR = join(process.cwd(), "packages");

function readPackageJson(path) {
	const content = readFileSync(path, "utf-8");
	return JSON.parse(content);
}

function writePackageJson(path, pkg) {
	writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
}

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

function updateInternalDependencies(pkg, version, internalNames) {
	const setVersion = (section) => {
		if (!section) {
			return;
		}

		for (const dep of Object.keys(section)) {
			if (internalNames.has(dep)) {
				const next = `^${version}`;
				if (section[dep] !== next) {
					section[dep] = next;
				}
			}
		}
	};

	setVersion(pkg.dependencies);
	setVersion(pkg.devDependencies);
}

function writeAllPackages(packages) {
	for (const pkg of packages) {
		writePackageJson(pkg.path, pkg.data);
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
		console.warn("⚠️  Could not update package-lock.json:", error.message);
	}
}

function main() {
	const bumpType = process.argv[2];
	
	if (!bumpType || !["patch", "minor", "major"].includes(bumpType)) {
		console.error("Usage: node version.js <patch|minor|major>");
		process.exit(1);
	}

	const rootPkg = readPackageJson(PACKAGE_JSON_PATH);
	const workspacePkgs = getWorkspacePackages();
	const internalNames = new Set(workspacePkgs.map((pkg) => pkg.name));

	const currentVersion = rootPkg.version;
	const newVersion = bumpVersion(currentVersion, bumpType);

	console.log(`🔼 Bumping version: ${currentVersion} → ${newVersion}`);

	// Update root package.json
	rootPkg.version = newVersion;
	updateInternalDependencies(rootPkg, newVersion, internalNames);
	writePackageJson(PACKAGE_JSON_PATH, rootPkg);
	console.log("✅ Updated package.json");

	// Update workspace package.json files
	for (const pkg of workspacePkgs) {
		pkg.data.version = newVersion;
		updateInternalDependencies(pkg.data, newVersion, internalNames);
	}
	writeAllPackages(workspacePkgs);
	console.log("✅ Updated workspace package.json files");

	// Update changelog
	updateChangelog(newVersion);

	// Update package-lock.json
	updatePackageLock(newVersion);

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
