#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import process from "node:process";

function parseArgs(argv) {
	const args = {
		base: process.env.BASE_SHA ?? "",
		changedFilesPath: "",
		eventName: process.env.EVENT_NAME ?? process.env.GITHUB_EVENT_NAME ?? "",
		head: process.env.HEAD_SHA ?? "",
		json: false,
		labels: process.env.PR_LABELS ?? "",
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--base":
				args.base = argv[++index] ?? "";
				break;
			case "--changed-files":
				args.changedFilesPath = argv[++index] ?? "";
				break;
			case "--event-name":
				args.eventName = argv[++index] ?? "";
				break;
			case "--head":
				args.head = argv[++index] ?? "";
				break;
			case "--json":
				args.json = true;
				break;
			case "--labels":
				args.labels = argv[++index] ?? "";
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	return args;
}

function normalizeLabels(labels) {
	if (Array.isArray(labels)) {
		return labels.map(String).map((label) => label.trim()).filter(Boolean);
	}
	return String(labels)
		.split(",")
		.map((label) => label.trim())
		.filter(Boolean);
}

function hasNoSlash(path) {
	return !path.includes("/");
}

function isNestedReadme(path, prefix) {
	const rest = path.startsWith(`${prefix}/`)
		? path.slice(prefix.length + 1)
		: "";
	return rest.includes("/") && rest.endsWith("/README.md");
}

function shouldSkipCoverageForPath(path) {
	return (
		(path.startsWith("docs/") && path.endsWith(".md")) ||
		isNestedReadme(path, "examples") ||
		isNestedReadme(path, "packages") ||
		isNestedReadme(path, "src") ||
		path === "CONTRIBUTING.md" ||
		path === "CODE_OF_CONDUCT.md" ||
		path === "SECURITY.md" ||
		path === "todo.md" ||
		(hasNoSlash(path) && path.startsWith("LICENSE"))
	);
}

function shouldSkipPublicMirrorForPath(path) {
	return (
		path.startsWith(".github/workflows/") ||
		path === ".github/PUBLIC_TREE_MIRROR_BOUNDARY.md" ||
		path === ".github/RELEASE_MIRROR_CONTRACT.md" ||
		path === "docs/release-ops.md" ||
		path.startsWith("docs/internal/") ||
		path === "scripts/configure-npm-trusted-publisher.mjs" ||
		path === "scripts/deprecate-release.js" ||
		path === "scripts/plan-ci-checks.mjs" ||
		path === "scripts/run-scenario-replay-gate.mjs" ||
		path === "scripts/scenario-replay-governance.mjs" ||
		path === "scripts/scenario-replay-governance.test.mjs" ||
		path === "scripts/smoke-registry-install.js" ||
		path === "scripts/validate-public-package-deps.js" ||
		path === "AGENTS.md" ||
		path === "CLAUDE.md"
	);
}

export function planCiChecks({ eventName, labels = [], changedFiles = [] }) {
	const normalizedLabels = normalizeLabels(labels);
	const labelSet = new Set(normalizedLabels);
	const isPullRequest = eventName === "pull_request";

	if (!isPullRequest) {
		return {
			coverage: true,
			publicMirror: true,
			reason: "non_pull_request",
		};
	}

	if (labelSet.has("full-ci")) {
		return {
			coverage: true,
			publicMirror: true,
			reason: "full_ci_label",
		};
	}

	const files = changedFiles.map(String).map((path) => path.trim()).filter(Boolean);
	const coverage =
		labelSet.has("run-coverage") ||
		files.some((path) => !shouldSkipCoverageForPath(path));
	const publicMirror =
		labelSet.has("run-public-mirror") ||
		files.some((path) => !shouldSkipPublicMirrorForPath(path));

	return {
		coverage,
		publicMirror,
		reason: "changed_files",
	};
}

function readChangedFilesFromGit(base, head) {
	if (!base || !head) {
		throw new Error("Pull request planning requires --base and --head when --changed-files is not provided.");
	}
	const output = execFileSync(
		"git",
		["diff", "--name-only", "--merge-base", base, head],
		{ encoding: "utf8" },
	);
	return output.split(/\r?\n/).filter(Boolean);
}

function readChangedFiles(args) {
	if (args.changedFilesPath) {
		return readFileSync(args.changedFilesPath, "utf8")
			.split(/\r?\n/)
			.filter(Boolean);
	}
	if (args.eventName === "pull_request" && !normalizeLabels(args.labels).includes("full-ci")) {
		return readChangedFilesFromGit(args.base, args.head);
	}
	return [];
}

function writeGitHubOutputs(plan) {
	if (!process.env.GITHUB_OUTPUT) {
		return;
	}
	appendFileSync(
		process.env.GITHUB_OUTPUT,
		`coverage=${plan.coverage}\npublic_mirror=${plan.publicMirror}\n`,
	);
}

function writeGitHubSummary(plan, changedFiles) {
	if (!process.env.GITHUB_STEP_SUMMARY) {
		return;
	}
	const lines = [
		"## Expensive check plan",
		"",
		`- coverage: \`${plan.coverage}\``,
		`- public release mirror: \`${plan.publicMirror}\``,
		`- reason: \`${plan.reason}\``,
	];
	if (changedFiles.length > 0) {
		lines.push("", "### Changed files", ...changedFiles.map((path) => `- ${path}`));
	}
	appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const changedFiles = readChangedFiles(args);
	const plan = planCiChecks({
		eventName: args.eventName,
		labels: args.labels,
		changedFiles,
	});

	writeGitHubOutputs(plan);
	writeGitHubSummary(plan, changedFiles);

	if (args.json) {
		process.stdout.write(`${JSON.stringify({ ...plan, changedFiles }, null, 2)}\n`);
	} else {
		process.stdout.write(
			`coverage=${plan.coverage}\npublic_mirror=${plan.publicMirror}\n`,
		);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
