#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isDirectCliEntrypoint } from "./direct-cli-entrypoint.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const defaultManifestPath = "docs/protocols/platform-runtime-conformance.json";

const requiredAreas = [
	"agentruntime-client-contract",
	"hosted-runtime-wiring",
	"hosted-progress-turns-steps-outcomes",
	"hosted-progress-waits-approvals-retries",
	"toolexecution-client-contract",
	"toolexecution-bridge-linkage",
	"toolexecution-bridge-approval-output",
	"live-platform-lifecycle-smoke",
	"a2a-live-evidence-contract",
	"a2a-push-message-boundary",
	"release-gate",
];

const requiredLifecycleClaims = [
	"turns",
	"model-steps",
	"tool-steps",
	"waits",
	"approvals",
	"tool-retries",
	"auto-retries",
	"outcomes",
	"toolexecution-linkage",
	"tool-output-records",
	"live-platform-smoke",
	"a2a-live-evidence",
	"durable-a2a-ids",
	"auth-boundaries",
	"trace-correlation",
	"push-notifications",
	"release-gate",
];

const allowedEvidenceTypes = new Set([
	"source",
	"test",
	"doc",
	"package-script",
	"live-smoke",
]);

export { isDirectCliEntrypoint };

export function loadPlatformRuntimeManifest(
	manifestPath = defaultManifestPath,
) {
	const absolutePath = resolve(root, manifestPath);
	return JSON.parse(readFileSync(absolutePath, "utf8"));
}

export function checkPlatformRuntimeConformance({
	manifest = loadPlatformRuntimeManifest(),
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
	const lifecycleClaims = new Set();
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
		if (check.area === "release-gate") {
			if (check.path !== "package.json") {
				failures.push(`${label} must use package.json as release-gate evidence`);
			}
			if (check.evidenceType !== "package-script") {
				failures.push(
					`${label} must use package-script evidence for release-gate validation`,
				);
			}
		}
		if (!Array.isArray(check.lifecycle) || check.lifecycle.length === 0) {
			failures.push(`${label} must list at least one lifecycle claim`);
		} else {
			for (const claim of check.lifecycle) {
				lifecycleClaims.add(claim);
			}
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
			if (typeof anchor !== "string" || anchor.trim().length === 0) {
				failures.push(`${label} has empty anchor`);
				continue;
			}
			if (!source.includes(anchor)) {
				failures.push(`${label} is missing anchor ${JSON.stringify(anchor)}`);
			}
		}
		if (check.evidenceType === "package-script") {
			failures.push(...validatePackageScriptEvidence({ check, source, label }));
		}
	}

	for (const requiredArea of requiredAreas) {
		if (!areas.has(requiredArea)) {
			failures.push(`manifest is missing required area ${requiredArea}`);
		}
	}

	for (const requiredClaim of requiredLifecycleClaims) {
		if (!lifecycleClaims.has(requiredClaim)) {
			failures.push(`manifest is missing lifecycle claim ${requiredClaim}`);
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

function validatePackageScriptEvidence({ check, source, label }) {
	const failures = [];
	let packageJson;
	try {
		packageJson = JSON.parse(source);
	} catch (error) {
		failures.push(`${label} points at invalid package.json: ${error.message}`);
		return failures;
	}
	if (check.area === "release-gate" && check.path === "package.json") {
		const checkScript =
			packageJson?.scripts?.["check:platform-runtime-conformance"];
		if (typeof checkScript !== "string") {
			failures.push(
				`${label} must define scripts.check:platform-runtime-conformance`,
			);
		} else if (
			!packageScriptRunsCommand(
				checkScript,
				"node scripts/check-platform-runtime-conformance.mjs",
			)
		) {
			failures.push(
				`${label} scripts.check:platform-runtime-conformance must run scripts/check-platform-runtime-conformance.mjs`,
			);
		}
		const lintEvals = packageJson?.scripts?.["lint:evals"];
		if (typeof lintEvals !== "string") {
			failures.push(`${label} must define scripts.lint:evals`);
		} else if (
			!packageScriptInvokes(lintEvals, "check:platform-runtime-conformance")
		) {
			failures.push(
				`${label} scripts.lint:evals must run check:platform-runtime-conformance`,
			);
		}
	}
	return failures;
}

function packageScriptRunsCommand(command, expectedCommand) {
	if (commandCanSwallowFailures(command)) {
		return false;
	}
	return command
		.split("&&")
		.some((segment) => segment.trim() === expectedCommand);
}

function packageScriptInvokes(command, scriptName) {
	if (commandCanSwallowFailures(command)) {
		return false;
	}
	return command
		.split("&&")
		.some((segment) =>
			new RegExp(
				`^(?:npm|bun)\\s+run\\s+${escapeRegExp(scriptName)}$`,
			).test(segment.trim()),
		);
}

function commandCanSwallowFailures(command) {
	return (
		command.includes("||") ||
		command.includes(";") ||
		/[\r\n]/u.test(command) ||
		/(^|[^&])&(?!&)/u.test(command)
	);
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function main() {
	const manifestPath = process.argv[2] ?? defaultManifestPath;
	const failures = checkPlatformRuntimeConformance({
		manifest: loadPlatformRuntimeManifest(manifestPath),
		rootDir: root,
	});
	if (failures.length > 0) {
		console.error("Platform runtime conformance failed:");
		for (const failure of failures) {
			console.error(`  - ${failure}`);
		}
		process.exit(1);
	}
	console.log("Platform runtime conformance passed");
}

if (isDirectCliEntrypoint(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
