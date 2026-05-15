#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isDirectCliEntrypoint } from "./direct-cli-entrypoint.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const defaultManifestPath = "docs/protocols/codex-operating-layer.json";

const requiredAreas = [
	"default-install",
	"chatgpt-sign-in",
	"dynamic-tools",
	"durable-threads-goals-memory",
	"approvals-sandbox-policy",
	"subagents",
	"multi-agent-workgraph",
	"realtime-streaming",
	"typescript-runtime",
	"rust-control-plane",
	"eval-telemetry",
	"operator-ux-docs",
	"live-verification",
];

const allowedEvidenceTypes = new Set([
	"source",
	"test",
	"doc",
	"fixture",
	"package-script",
	"scenario",
	"live-smoke",
]);

export { isDirectCliEntrypoint };

export function loadCodexOperatingLayerManifest(
	manifestPath = defaultManifestPath,
) {
	const absolutePath = resolve(root, manifestPath);
	return JSON.parse(readFileSync(absolutePath, "utf8"));
}

export function checkCodexOperatingLayerConformance({
	manifest = loadCodexOperatingLayerManifest(),
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
		const absolutePath = join(rootDir, check.path);
		if (!existsSync(absolutePath)) {
			failures.push(`${label} points at missing file`);
			continue;
		}
		const source = readFileSync(absolutePath, "utf8");
		for (const anchor of check.anchors) {
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

function main() {
	const manifestPath = process.argv[2] ?? defaultManifestPath;
	const failures = checkCodexOperatingLayerConformance({
		manifest: loadCodexOperatingLayerManifest(manifestPath),
		rootDir: root,
	});
	if (failures.length > 0) {
		console.error("Codex operating-layer conformance failed:");
		for (const failure of failures) {
			console.error(`  - ${failure}`);
		}
		process.exit(1);
	}
	console.log("Codex operating-layer conformance passed");
}

if (isDirectCliEntrypoint(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
