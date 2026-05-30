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
	"published-replay-evidence-verifier",
	"published-replay-release-gate",
	"release-readiness",
	"release-workflow",
	"tag-release-workflow",
	"public-mirror-workflow",
	"public-mirror-package-scripts",
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

const registryInstallSmokeRequiredAnchors = [
	'["install", packageSpec]',
	'["add", packageSpec]',
	"runPublishedReplayE2E",
	"runNpxCliSmoke",
	"runBunxCliSmoke",
	"runBunRuntimeCliSmoke",
	"MAESTRO_ALLOW_REGISTRY_BUN_INSTALL_SMOKE_SKIP",
];

const publishedReplayEvidenceVerifierRequiredAnchors = [
	'const REQUIRED_INSTALLERS = ["npm", "bun"];',
	'const REQUIRED_REPLAY_MODES = ["json", "rpc", "text"];',
	'"toolExecutionEvidence"',
	'"searchRipgrepEvidence"',
	'"queryableObservabilityIndex"',
	'"agentRuntimeLedger"',
	'"agentRuntimeLifecycle"',
	'"agent-runtime-lifecycle"',
	"function toolExecutionCoverageIsValid",
	"function agentRuntimeLifecycleIsValid",
	"assertPublishedReplayReleaseGate(evidence);",
];

const publishedReplayReleaseGateRequiredAnchors = [
	"export function assertPublishedReplayReleaseGate",
	"evidence?.releaseGate?.satisfied === true",
	"Published replay release gate failed",
];

const publicMirrorPackageScriptRequiredAnchors = [
	'pkg.scripts["release:verify:published"] =',
	'"node scripts/smoke-registry-install.js";',
	'pkg.scripts["release:verify:published:e2e"] =',
	'"node scripts/smoke-published-replay-e2e.js";',
	'pkg.scripts["release:verify:published:evidence"] =',
	'"node scripts/verify-published-replay-evidence.js";',
	'pkg.scripts["release:deprecate"] = "node scripts/deprecate-release.js";',
];

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
		if (check.area === "release-gate-scripts") {
			if (check.path !== "package.json") {
				failures.push(
					`${label} must use package.json as release-gate script evidence`,
				);
			}
			if (check.evidenceType !== "package-script") {
				failures.push(
					`${label} must use package-script evidence for release-gate validation`,
				);
			}
		}
		if (check.area === "registry-install-smoke") {
			if (check.path !== "scripts/smoke-registry-install.js") {
				failures.push(
					`${label} must use scripts/smoke-registry-install.js as registry smoke evidence`,
				);
			}
			if (check.evidenceType !== "live-smoke") {
				failures.push(
					`${label} must use live-smoke evidence for registry install validation`,
				);
			}
			for (const requiredAnchor of registryInstallSmokeRequiredAnchors) {
				if (!check.anchors?.includes(requiredAnchor)) {
					failures.push(`${label} must anchor ${requiredAnchor}`);
				}
			}
		}
		if (check.area === "published-replay-evidence-verifier") {
			if (check.path !== "scripts/verify-published-replay-evidence.js") {
				failures.push(
					`${label} must use scripts/verify-published-replay-evidence.js as published replay verifier evidence`,
				);
			}
			if (check.evidenceType !== "source") {
				failures.push(
					`${label} must use source evidence for published replay verifier validation`,
				);
			}
			for (const requiredAnchor of publishedReplayEvidenceVerifierRequiredAnchors) {
				if (!check.anchors?.includes(requiredAnchor)) {
					failures.push(`${label} must anchor ${requiredAnchor}`);
				}
			}
		}
		if (check.area === "published-replay-release-gate") {
			if (check.path !== "scripts/published-replay-evidence-gate.js") {
				failures.push(
					`${label} must use scripts/published-replay-evidence-gate.js as published replay release-gate evidence`,
				);
			}
			if (check.evidenceType !== "source") {
				failures.push(
					`${label} must use source evidence for published replay release-gate validation`,
				);
			}
			for (const requiredAnchor of publishedReplayReleaseGateRequiredAnchors) {
				if (!check.anchors?.includes(requiredAnchor)) {
					failures.push(`${label} must anchor ${requiredAnchor}`);
				}
			}
		}
		if (check.area === "public-mirror-package-scripts") {
			if (check.path !== "scripts/prepare-public-release-mirror.mjs") {
				failures.push(
					`${label} must use scripts/prepare-public-release-mirror.mjs as public mirror package-script evidence`,
				);
			}
			if (check.evidenceType !== "source") {
				failures.push(
					`${label} must use source evidence for public mirror package-script validation`,
				);
			}
			for (const requiredAnchor of publicMirrorPackageScriptRequiredAnchors) {
				if (!check.anchors?.includes(requiredAnchor)) {
					failures.push(`${label} must anchor ${requiredAnchor}`);
				}
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
			if (typeof anchor !== "string" || anchor.length === 0) {
				failures.push(`${label} contains an invalid anchor`);
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

	return failures;
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
	if (check.area === "release-gate-scripts" && check.path === "package.json") {
		const releaseCheck = packageJson?.scripts?.["release:check"];
		if (typeof releaseCheck !== "string") {
			failures.push(`${label} must define scripts.release:check`);
		} else if (
			!packageScriptRunsCommand(
				releaseCheck,
				"node scripts/release-readiness.js release",
			)
		) {
			failures.push(
				`${label} scripts.release:check must run scripts/release-readiness.js release`,
			);
		}

		const checkScript = packageJson?.scripts?.["check:release-surface"];
		if (typeof checkScript !== "string") {
			failures.push(`${label} must define scripts.check:release-surface`);
		} else if (
			!packageScriptRunsCommand(
				checkScript,
				"node scripts/check-release-surface-conformance.mjs",
			)
		) {
			failures.push(
				`${label} scripts.check:release-surface must run scripts/check-release-surface-conformance.mjs`,
			);
		}

		const lintEvals = packageJson?.scripts?.["lint:evals"];
		if (typeof lintEvals !== "string") {
			failures.push(`${label} must define scripts.lint:evals`);
		} else if (!packageScriptInvokes(lintEvals, "check:release-surface")) {
			failures.push(
				`${label} scripts.lint:evals must run check:release-surface`,
			);
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
