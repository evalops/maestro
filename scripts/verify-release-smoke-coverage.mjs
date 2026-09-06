#!/usr/bin/env node
// Refuse to publish a release containing a binary that was never smoke-tested.
//
// Each matrix leg in .github/workflows/release.yml runs smoke against the
// artifact it just built and writes smoked-<platform>.txt holding that
// artifact's sha256. This script re-hashes every downloaded binary and
// requires a matching marker.
//
// Platforms are either:
//   - MAESTRO_RELEASE_PLATFORMS (space- or comma-separated), from the plan job
//   - or inferred from maestro-* binaries present under the artifact directory

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "release-binaries";
if (!existsSync(dir)) {
	console.error(`Release artifact directory not found: ${dir}`);
	process.exit(1);
}

const fromEnv = (process.env.MAESTRO_RELEASE_PLATFORMS || "")
	.split(/[\s,]+/)
	.map((s) => s.trim())
	.filter(Boolean);

const inferred = readdirSync(dir)
	.map((name) => {
		const match = /^maestro-(linux|darwin)-(x64|arm64)$/.exec(name);
		return match ? `${match[1]}-${match[2]}` : null;
	})
	.filter(Boolean);

const PLATFORMS = fromEnv.length > 0 ? fromEnv : inferred;

if (PLATFORMS.length === 0) {
	console.error("No release platforms found (set MAESTRO_RELEASE_PLATFORMS or ship maestro-* binaries).");
	process.exit(1);
}

// Always require linux-x64 — publish smoke runs that host binary.
if (!PLATFORMS.includes("linux-x64")) {
	console.error("Release platforms must include linux-x64 (publish host smoke).");
	process.exit(1);
}

const sha256 = (path) =>
	createHash("sha256").update(readFileSync(path)).digest("hex");

const failures = [];
const macosSignatures = [];

for (const platform of PLATFORMS) {
	const binary = join(dir, `maestro-${platform}`);
	const marker = join(dir, `smoked-${platform}.txt`);

	if (!existsSync(binary)) {
		failures.push(`${platform}: binary missing (${binary})`);
		continue;
	}
	const actual = sha256(binary);
	if (!existsSync(marker)) {
		failures.push(
			`${platform}: no smoke marker — this binary was never smoke-tested`,
		);
		continue;
	}
	if (platform.startsWith("darwin-")) {
		const signatureMarker = join(dir, `signed-${platform}.json`);
		if (!existsSync(signatureMarker)) {
			failures.push(`${platform}: no macOS Developer ID signature marker`);
			continue;
		}
		try {
			const signature = JSON.parse(readFileSync(signatureMarker, "utf8"));
			if (
				signature.schema !== "evalops.maestro.macos-release-signature.v1" ||
				!/^Developer ID Application: .+/.test(signature.authority || "") ||
				!/^[A-Z0-9]{10}$/.test(signature.teamIdentifier || "") ||
				signature.binarySha256 !== actual
			) {
				failures.push(`${platform}: invalid Developer ID signature marker`);
				continue;
			}
			macosSignatures.push(signature);
		} catch {
			failures.push(`${platform}: macOS Developer ID signature marker is not valid JSON`);
			continue;
		}
		const notarizationMarker = join(dir, `notarized-${platform}.json`);
		if (!existsSync(notarizationMarker)) {
			failures.push(`${platform}: no Apple notarization marker`);
			continue;
		}
		try {
			const notarization = JSON.parse(readFileSync(notarizationMarker, "utf8"));
			if (
				notarization.schema !== "evalops.maestro.macos-notarization.v1" ||
				notarization.status !== "Accepted" ||
				notarization.platform !== platform ||
				!notarization.submissionId ||
				notarization.binarySha256 !== actual
			) {
				failures.push(`${platform}: invalid Apple notarization marker or binary digest`);
				continue;
			}
		} catch {
			failures.push(`${platform}: Apple notarization marker is not valid JSON`);
			continue;
		}
	}

	const recorded = readFileSync(marker, "utf8").trim().split(/\s+/)[0];
	if (recorded !== actual) {
		failures.push(
			`${platform}: smoke marker covers ${recorded} but the shipped binary is ${actual}`,
		);
		continue;
	}
	console.log(`ok  ${platform}  smoked  sha256=${actual}`);
}

if (macosSignatures.length > 1) {
	const teams = new Set(macosSignatures.map((signature) => signature.teamIdentifier));
	const authorities = new Set(macosSignatures.map((signature) => signature.authority));
	if (teams.size !== 1 || authorities.size !== 1) {
		failures.push("darwin release binaries do not share one stable Developer ID authority and TeamIdentifier");
	}
}

// A platform binary present but not in PLATFORMS would ship unchecked.
for (const entry of readdirSync(dir)) {
	if (!entry.startsWith("maestro-")) continue;
	if (entry.endsWith(".txt")) continue;
	const platform = entry.slice("maestro-".length);
	if (!PLATFORMS.includes(platform)) {
		failures.push(
			`${entry}: built but absent from the release platform list (${PLATFORMS.join(", ")})`,
		);
	}
}

if (failures.length > 0) {
	console.error("\nRelease smoke coverage check failed:");
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}

console.log(
	`\nAll ${PLATFORMS.length} shipped binaries were smoke-tested (${PLATFORMS.join(", ")}).`,
);
