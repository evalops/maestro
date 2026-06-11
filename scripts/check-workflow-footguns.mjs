#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

function evaluatePublicReleaseMirrorWorkflowPermission(root) {
	const failures = [];
	if (!manifestMirrorsWorkflowFiles(root)) return failures;

	const path = join(root, ".github/workflows/public-release-mirror.yml");
	const workflowText = readIfExists(path);
	if (!workflowText) return failures;

	const appTokenBlocks = workflowStepBlocks(workflowText).filter((block) =>
		/actions\/create-github-app-token@/.test(block),
	);
	for (const block of appTokenBlocks) {
		if (!/permission-workflows:\s*write\b/.test(block)) {
			failures.push(
				".github/workflows/public-release-mirror.yml: GitHub App token must request permission-workflows: write before syncing release mirror workflow files",
			);
		}
		if (!/permission-contents:\s*write\b/.test(block)) {
			failures.push(
				".github/workflows/public-release-mirror.yml: GitHub App token must preserve permission-contents: write when requesting workflow permission",
			);
		}
	}

	return failures;
}

function evaluatePullRequestRunnerOverrides(root) {
	const failures = [];
	const workflowFiles = [
		".github/workflows/ci.yml",
		".github/workflows/rust.yml",
	];
	const disallowedVariables = [
		"PR_CHECKS_RUNNER",
		"PR_COVERAGE_RUNNER",
		"PR_RUST_RUNNER",
	];

	for (const workflowFile of workflowFiles) {
		const workflowText = readIfExists(join(root, workflowFile));
		for (const variable of disallowedVariables) {
			if (new RegExp(`\\bvars\\.${variable}\\b`).test(workflowText)) {
				failures.push(
					`${workflowFile}: pull_request jobs must not use vars.${variable}; keep PR CI on evalops-private-ci or evalops-private-heavy so internal smoke runners stay available`,
				);
			}
		}
	}

	return failures;
}

export function evaluateWorkflowFootguns({ root = defaultRoot } = {}) {
	return [
		...evaluateEvalOpsBotDispatch(root),
		...evaluatePublicReleaseMirrorWorkflowPermission(root),
		...evaluatePullRequestRunnerOverrides(root),
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
