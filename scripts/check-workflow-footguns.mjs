#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = fileURLToPath(new URL("..", import.meta.url));

function readIfExists(path) {
	if (!existsSync(path)) return "";
	return readFileSync(path, "utf8");
}

function workflowStepBlocks(workflowText) {
	const blocks = [];
	let current = [];
	for (const line of workflowText.split("\n")) {
		if (/^\s{6}-\s/.test(line) && current.length > 0) {
			blocks.push(current.join("\n"));
			current = [line];
			continue;
		}
		if (current.length > 0 || /^\s{6}-\s/.test(line)) {
			current.push(line);
		}
	}
	if (current.length > 0) {
		blocks.push(current.join("\n"));
	}
	return blocks;
}

function manifestMirrorsWorkflowFiles(root) {
	const manifestPath = join(root, ".github/release-mirror-manifest.json");
	if (!existsSync(manifestPath)) return false;
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	return Array.isArray(manifest.files)
		? manifest.files.some(
				(file) =>
					typeof file === "string" && file.startsWith(".github/workflows/"),
			)
		: false;
}

function evaluateEvalOpsBotDispatch(root) {
	const failures = [];
	const path = join(root, ".github/workflows/evalopsbot-review-request.yml");
	const workflowText = readIfExists(path);
	if (!workflowText) return failures;

	const hasTokenResolver =
		/\bid:\s*dispatch-token\b/.test(workflowText) &&
		/configured=false/.test(workflowText) &&
		/::warning::.*EVALOPS_PR_LENS_TOKEN/.test(workflowText);
	const hasHardFailure =
		/::error::Set EVALOPS_PR_LENS_TOKEN/.test(workflowText) ||
		/exit\s+[1-9]\d*/.test(
			workflowStepBlocks(workflowText)
				.filter((block) => /EVALOPS_PR_LENS_TOKEN|GH_TOKEN/.test(block))
				.join("\n"),
		);

	if (!hasTokenResolver || hasHardFailure) {
		failures.push(
			".github/workflows/evalopsbot-review-request.yml: dispatch token must skip gracefully when EVALOPS_PR_LENS_TOKEN is unavailable",
		);
	}

	const ungatedDispatchSteps = workflowStepBlocks(workflowText).filter(
		(block) =>
			/gh api\b/.test(block) &&
			!/if:\s*\$\{\{\s*steps\.dispatch-token\.outputs\.configured\s*==\s*'true'\s*\}\}/.test(
				block,
			),
	);
	if (ungatedDispatchSteps.length > 0) {
		failures.push(
			".github/workflows/evalopsbot-review-request.yml: gh api dispatch/status steps must be gated on steps.dispatch-token.outputs.configured == 'true'",
		);
	}

	return failures;
}

function evaluatePublicMirrorWorkflowBoundary(root) {
	const failures = [];
	if (manifestMirrorsWorkflowFiles(root)) {
		failures.push(
			".github/release-mirror-manifest.json: public workflows are public-owned and must not be mirrored from internal",
		);
	}

	const prepareScript = readIfExists(
		join(root, "scripts/prepare-public-release-mirror.mjs"),
	);
	if (/PUBLIC_INCLUDE_OVERRIDES[\s\S]*?\.github\/workflows\//.test(prepareScript)) {
		failures.push(
			"scripts/prepare-public-release-mirror.mjs: public workflow files must not be re-included by mirror preparation",
		);
	}

	for (const workflowPath of [
		".github/workflows/public-release-mirror.yml",
		".github/workflows/sync-public-release-mirror.yml",
	]) {
		const workflowText = readIfExists(join(root, workflowPath));
		if (!workflowText) continue;

		const appTokenBlocks = workflowStepBlocks(workflowText).filter((block) =>
			/actions\/create-github-app-token@/.test(block),
		);
		for (const block of appTokenBlocks) {
			if (/permission-workflows:\s*write\b/.test(block)) {
				failures.push(
					`${workflowPath}: public mirror App must remain contents-only because public owns workflow files`,
				);
			}
			if (!/permission-contents:\s*write\b/.test(block)) {
				failures.push(
					`${workflowPath}: public mirror App must request permission-contents: write`,
				);
			}
			if (!/permission-pull-requests:\s*write\b/.test(block)) {
				failures.push(
					`${workflowPath}: public mirror App must request permission-pull-requests: write to maintain generated mirror PRs`,
				);
			}
		}
		if (!/git status --porcelain -- \.github\/workflows/.test(workflowText)) {
			failures.push(
				`${workflowPath}: mirror publication must fail if public-owned workflow files change`,
			);
		}
	}

	return failures;
}

/**
 * PR CI must not steal the trusted `evalops-internal` lane.
 *
 * Policy (aligned with test/scripts/ci-guardrails.test.ts):
 * - PR jobs route through vars.PR_CHECKS_RUNNER with an ubuntu-latest
 *   fallback so automation works when the var is unset.
 * - `evalops-internal` is reserved for non-PR confirmation (via
 *   INTERNAL_CONFIRMATION_RUNNER), never as a hard-coded PR target.
 */
function evaluatePullRequestRunnerOverrides(root) {
	const failures = [];
	const workflowFiles = [
		".github/workflows/ci.yml",
		".github/workflows/rust.yml",
	];

	for (const workflowFile of workflowFiles) {
		const workflowText = readIfExists(join(root, workflowFile));
		if (!workflowText) continue;

		const runsOnLines = workflowText
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.startsWith("runs-on:"));

		for (const line of runsOnLines) {
			if (!line.includes("pull_request")) continue;

			// Bare trusted-lane label as a PR target (no var wrapper).
			if (
				/&&\s*'evalops-internal'/.test(line) ||
				/&&\s*"evalops-internal"/.test(line)
			) {
				failures.push(
					`${workflowFile}: pull_request jobs must not hard-code evalops-internal; route PR CI through PR_CHECKS_RUNNER (or ubuntu-latest)`,
				);
			}
		}

		// Primary ci.yml PR lanes must keep a runner failover var so release
		// automation is not pinned to a single fleet.
		if (workflowFile.endsWith("ci.yml") && workflowText.includes("pr-checks")) {
			if (
				!/\bvars\.PR_CHECKS_RUNNER\b/.test(workflowText) &&
				!/\bvars\.PUBLIC_PR_VALIDATION_RUNNER\b/.test(workflowText)
			) {
				failures.push(
					`${workflowFile}: PR jobs must expose vars.PR_CHECKS_RUNNER or vars.PUBLIC_PR_VALIDATION_RUNNER for runner failover`,
				);
			}
		}
	}

	return failures;
}

/**
 * Blacksmith runners are retired org-wide (owner decision 2026-07-20).
 * Fail any workflow, composite action, or actionlint config that still
 * references a blacksmith-* runner label or a BLACKSMITH_* fallback var so
 * the fleet cannot silently creep back in. Scans all of .github/ (not just
 * .github/workflows/) so a composite action under .github/actions/** or the
 * self-hosted-runner label registry in .github/actionlint.yaml can't
 * reintroduce a reference unnoticed.
 */
function evaluateNoBlacksmithReferences(root) {
	const failures = [];
	const githubDir = join(root, ".github");
	if (!existsSync(githubDir)) return failures;

	for (const entry of readdirSync(githubDir, { recursive: true })) {
		if (!/\.ya?ml$/.test(entry)) continue;
		const relativePath = `.github/${entry.split(sep).join("/")}`;
		const fileText = readIfExists(join(root, relativePath));
		if (/blacksmith/i.test(fileText)) {
			failures.push(
				`${relativePath}: Blacksmith runners are retired; use GitHub-hosted runners (e.g. ubuntu-latest, macos-15, ubuntu-24.04-arm) instead of blacksmith-* labels or BLACKSMITH_* vars`,
			);
		}
	}

	return failures;
}

export function evaluateWorkflowFootguns({ root = defaultRoot } = {}) {
	return [
		...evaluateEvalOpsBotDispatch(root),
		...evaluatePublicMirrorWorkflowBoundary(root),
		...evaluatePullRequestRunnerOverrides(root),
		...evaluateNoBlacksmithReferences(root),
	];
}

function main() {
	const failures = evaluateWorkflowFootguns({ root: process.cwd() });
	if (failures.length === 0) {
		console.log("Workflow footgun guardrails passed.");
		return;
	}
	for (const failure of failures) {
		console.error(failure);
	}
	process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}
