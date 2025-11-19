#!/usr/bin/env node
/**
 * Version bumping script for Composer CLI
 * Usage:
 *   npm run version:patch
 *   npm run version:minor
 *   npm run version:major
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const PACKAGE_JSON_PATH = join(process.cwd(), "package.json");

function readPackageJson() {
	const content = readFileSync(PACKAGE_JSON_PATH, "utf-8");
	return JSON.parse(content);
}

function writePackageJson(pkg) {
	writeFileSync(PACKAGE_JSON_PATH, JSON.stringify(pkg, null, 2) + "\n");
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

	const pkg = readPackageJson();
	const currentVersion = pkg.version;
	const newVersion = bumpVersion(currentVersion, bumpType);

	console.log(`🔼 Bumping version: ${currentVersion} → ${newVersion}`);

	// Update package.json
	pkg.version = newVersion;
	writePackageJson(pkg);
	console.log("✅ Updated package.json");

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
