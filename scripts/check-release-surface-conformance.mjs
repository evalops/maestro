#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isDirectCliEntrypoint } from "./direct-cli-entrypoint.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const defaultManifestPath = "docs/protocols/release-surface-conformance.json";

const requiredAreas = [
	"public-install-docs",
	"package-metadata",
	"release-gate-scripts",
	"forbidden-workspace-deps",
	"packed-runtime-workspaces",
	"installed-package-audit",
	"registry-install-smoke",
	"published-replay-e2e",
	"release-readiness",
	"release-workflow",
	"public-mirror-workflow",
	"public-mirror-contract",
	"prepared-public-mirror",
	"release-surface-docs",
];

const allowedEvidenceTypes = new Set([
	"source",
	"test",
	"doc",
	"fixture",
	"package-script",
	"live-smoke",
]);

export function loadReleaseSurfaceConformanceManifest(
	manifestPath = defaultManifestPath,
) {
	const absolutePath = resolve(root, manifestPath);
	return JSON.parse(readFileSync(absolutePath, "utf8"));
}

export function checkReleaseSurfaceConformance({
	manifest = loadReleaseSurfaceConformanceManifest(),
	rootDir = root,
} = {}) {
	const failures = [];
	if (manifest.version !== 1) {
		failures.push("manifest version must be 1");
	}
	if (!Array.isArray(manifest.checks) || manifest.checks.length === 0) {
		failures.push("manifest must contain at least one check");
		return failures;
	}

	const rootPath = resolve(rootDir);
	const rootRealPath = realpathSync(rootPath);
	const areas = new Set();
	for (const [index, check] of manifest.checks.entries()) {
		const label = check?.area
			? `${check.area}: ${check.path}`
			: `check #${index + 1}`;
		if (!check?.area) {
			failures.push(`${label} is missing area`);
		} else {
			areas.add(check.area);
		}
		if (!check?.path) {
			failures.push(`${label} is missing path`);
			continue;
		}
		if (!check?.evidenceType) {
			failures.push(`${label} is missing evidenceType`);
		} else if (!allowedEvidenceTypes.has(check.evidenceType)) {
			failures.push(
				`${label} has unsupported evidenceType ${JSON.stringify(check.evidenceType)}`,
			);
		}
		if (!Array.isArray(check.anchors) || check.anchors.length === 0) {
			failures.push(`${label} must list at least one anchor`);
			continue;
		}
		const absolutePath = resolve(rootPath, check.path);
		if (!pathStaysWithinRoot(rootPath, absolutePath)) {
			failures.push(`${label} escapes repository root`);
			continue;
		}
		if (!existsSync(absolutePath)) {
			failures.push(`${label} points at missing file`);
			continue;
		}
		const realPath = realpathSync(absolutePath);
		if (!pathStaysWithinRoot(rootRealPath, realPath)) {
			failures.push(`${label} escapes repository root`);
			continue;
		}
		const source = readFileSync(realPath, "utf8");
		for (const anchor of check.anchors) {
			if (typeof anchor !== "string" || anchor.length === 0) {
				failures.push(`${label} contains an invalid anchor`);
				continue;
			}
			if (!source.includes(anchor)) {
				failures.push(`${label} is missing anchor ${JSON.stringify(anchor)}`);
			}
		}
	}

	for (const requiredArea of requiredAreas) {
		if (!areas.has(requiredArea)) {
			failures.push(`manifest is missing required area ${requiredArea}`);
		}
	}

	return failures;
}

function pathStaysWithinRoot(rootPath, targetPath) {
	const relativePath = relative(rootPath, targetPath);
	return (
		relativePath === "" ||
		(!relativePath.startsWith("..") && !isAbsolute(relativePath))
	);
}

function main() {
	const manifestPath = process.argv[2] ?? defaultManifestPath;
	const failures = checkReleaseSurfaceConformance({
		manifest: loadReleaseSurfaceConformanceManifest(manifestPath),
		rootDir: root,
	});
	if (failures.length > 0) {
		console.error("Release surface conformance failed:");
		for (const failure of failures) {
			console.error(`  - ${failure}`);
		}
		process.exit(1);
	}
	console.log("Release surface conformance passed");
}

if (isDirectCliEntrypoint(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
