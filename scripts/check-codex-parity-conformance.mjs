#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isDirectCliEntrypoint } from "./direct-cli-entrypoint.mjs";

export { isDirectCliEntrypoint };

const root = fileURLToPath(new URL("..", import.meta.url));
const defaultManifestPath = "docs/protocols/codex-parity-conformance.json";

export function loadCodexParityManifest(manifestPath = defaultManifestPath) {
	const absolutePath = resolve(root, manifestPath);
	return JSON.parse(readFileSync(absolutePath, "utf8"));
}

export function checkCodexParityConformance({
	manifest = loadCodexParityManifest(),
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
		const label = check?.area ? `${check.area}: ${check.path}` : `check #${index + 1}`;
		if (!check?.area) {
			failures.push(`${label} is missing area`);
		} else {
			areas.add(check.area);
		}
		if (!check?.path) {
			failures.push(`${label} is missing path`);
			continue;
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

	for (const requiredArea of [
		"codex-auth-provider",
		"native-apply-patch",
		"mcp-resource-prompt-bridge",
		"prompt-queue-parity",
		"hosted-runtime-parity",
	]) {
		if (!areas.has(requiredArea)) {
			failures.push(`manifest is missing required area ${requiredArea}`);
		}
	}

	return failures;
}

function main() {
	const manifestPath = process.argv[2] ?? defaultManifestPath;
	const failures = checkCodexParityConformance({
		manifest: loadCodexParityManifest(manifestPath),
		rootDir: root,
	});
	if (failures.length > 0) {
		console.error("Codex parity conformance failed:");
		for (const failure of failures) {
			console.error(`  - ${failure}`);
		}
		process.exit(1);
	}
	console.log("Codex parity conformance passed");
}

if (isDirectCliEntrypoint(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
