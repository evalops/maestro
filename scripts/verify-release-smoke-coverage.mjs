#!/usr/bin/env node
// Refuse to publish a release containing a binary that was never executed.
//
// Each matrix leg in .github/workflows/release.yml runs the native smoke
// against the artifact it just built and writes smoked-<platform>.txt holding
// that artifact's sha256. This script re-hashes every downloaded binary and
// requires a matching marker, so a matrix leg that skipped, was filtered out
// by an `if:`, or never started cannot reach the GitHub Release unnoticed.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PLATFORMS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];

const dir = process.argv[2] ?? "release-binaries";
if (!existsSync(dir)) {
	console.error(`Release artifact directory not found: ${dir}`);
	process.exit(1);
}

const sha256 = (path) =>
	createHash("sha256").update(readFileSync(path)).digest("hex");

const failures = [];

for (const platform of PLATFORMS) {
	const binary = join(dir, `maestro-${platform}`);
	const marker = join(dir, `smoked-${platform}.txt`);

	if (!existsSync(binary)) {
		failures.push(`${platform}: binary missing (${binary})`);
		continue;
	}
	if (!existsSync(marker)) {
		failures.push(
			`${platform}: no smoke marker — this binary was never executed on its own platform`,
		);
		continue;
	}

	const recorded = readFileSync(marker, "utf8").trim().split(/\s+/)[0];
	const actual = sha256(binary);
	if (recorded !== actual) {
		failures.push(
			`${platform}: smoke marker covers ${recorded} but the shipped binary is ${actual}`,
		);
		continue;
	}
	console.log(`ok  ${platform}  smoked  sha256=${actual}`);
}

// A platform added to the release matrix but not to PLATFORMS would otherwise
// ship unchecked. Fail on any binary this script does not know about.
for (const entry of readdirSync(dir)) {
	if (!entry.startsWith("maestro-")) continue;
	const platform = entry.slice("maestro-".length);
	if (!PLATFORMS.includes(platform)) {
		failures.push(
			`${entry}: built but absent from the smoke-coverage list; add "${platform}" to PLATFORMS`,
		);
	}
}

if (failures.length > 0) {
	console.error("\nRelease smoke coverage check failed:");
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}

console.log(
	`\nAll ${PLATFORMS.length} shipped binaries were smoke-tested on their own platform.`,
);
