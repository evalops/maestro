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

const CI_GUARDRAIL_FILES = new Set([
	"scripts/check-smoke-scripts.mjs",
	"scripts/ci-nx-tests.sh",
	"scripts/plan-ci-checks.mjs",
	"scripts/plan-nx-test-command.mjs",
	"scripts/summarize-nx-profile.mjs",
	"test/scripts/ci-guardrails.test.ts",
]);
const RUNTIME_PACKAGE_VALIDATOR_FILES = new Set([
	"scripts/bundle-runtime-deps.mjs",
	"scripts/check-docker-runtime-workspaces.mjs",
	"scripts/check-packed-bundled-workspaces.mjs",
	"scripts/check-runtime-deps.js",
	"scripts/install-smoke-utils.js",
	"scripts/release-readiness.js",
	"scripts/runtime-workspaces.mjs",
	"scripts/validate-public-package-deps.js",
	"scripts/workspace-utils.js",
]);
const RELEASE_HELPER_PACKAGE_FILES = new Set([
	"scripts/configure-npm-trusted-publisher.mjs",
	"scripts/deprecate-release.js",
	"scripts/install-smoke-utils.js",
	"scripts/release-readiness.js",
	"scripts/smoke-packed-cli.js",
	"scripts/smoke-published-replay-e2e.js",
	"scripts/smoke-registry-install.js",
	"scripts/workspace-utils.js",
]);
const RELEASE_HELPER_TEST_FILES = new Set([
	"test/scripts/install-smoke-utils.test.ts",
	"test/scripts/release-context-deps.test.ts",
	"test/scripts/workspace-utils.test.ts",
]);

function isPackageManifest(path) {
	return path === "package.json" || /^packages\/[^/]+\/package\.json$/.test(path);
}

function isTestFile(path) {
	return /(^|\/)test\/.*\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

function isSmokeScript(path) {
	return /^scripts\/smoke-[^/]+\.[cm]?[jt]sx?$/.test(path);
}

function isLeafIdeExtensionPath(path) {
	return path.startsWith("packages/vscode-extension/") && !isPackageManifest(path);
}

function shouldSkipCoverageForPath(path) {
	return (
		path.startsWith(".github/workflows/") ||
		(path.startsWith("docs/") && path.endsWith(".md")) ||
		CI_GUARDRAIL_FILES.has(path) ||
		RELEASE_HELPER_PACKAGE_FILES.has(path) ||
		RUNTIME_PACKAGE_VALIDATOR_FILES.has(path) ||
		isLeafIdeExtensionPath(path) ||
		isSmokeScript(path) ||
		isPackageManifest(path) ||
		isTestFile(path) ||
		isNestedReadme(path, "examples") ||
		isNestedReadme(path, "packages") ||
		isNestedReadme(path, "src") ||
		path === "CHANGELOG.md" ||
		path === "CONTRIBUTING.md" ||
		path === "CODE_OF_CONDUCT.md" ||
		path === "SECURITY.md" ||
		path === "openapi.json" ||
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
		path === "scripts/run-scenario-replay-gate.mjs" ||
		path === "scripts/scenario-replay-governance.mjs" ||
		path === "scripts/scenario-replay-governance.test.mjs" ||
		path === "scripts/validate-public-package-deps.js" ||
		path === "AGENTS.md" ||
		path === "CLAUDE.md"
	);
}

function isWorkflowFile(path) {
	return path.startsWith(".github/workflows/") && /\.ya?ml$/.test(path);
}

function isCiInfrastructureOnlyPath(path) {
	return (
		isWorkflowFile(path) ||
		path === "scripts/plan-ci-checks.mjs" ||
		path === "test/scripts/ci-guardrails.test.ts"
	);
}

function isRustSetupActionPath(path) {
	return path.startsWith(".github/actions/setup-rust/");
}

function isFastPrChecksInfrastructurePath(path) {
	return isCiInfrastructureOnlyPath(path) || isRustSetupActionPath(path);
}

function isProofHarnessPath(path) {
	return (
		CI_GUARDRAIL_FILES.has(path) ||
		isFastPrChecksInfrastructurePath(path) ||
		(path.startsWith("docs/") && path.endsWith(".md")) ||
		isSmokeScript(path)
	);
}

function isRustOnlySourcePath(path) {
	return (
		path.startsWith("packages/ambient-agent-rs/") ||
		path.startsWith("packages/control-plane-rs/") ||
		path.startsWith("packages/tui-rs/") ||
		path.startsWith("examples/hooks/wasm-plugin/")
	);
}

function isRustHostedConformancePath(path) {
	return isRustSetupActionPath(path) || isRustOnlySourcePath(path);
}

function isLightPrChecksPath(path) {
	return (
		isCiInfrastructureOnlyPath(path) ||
		CI_GUARDRAIL_FILES.has(path) ||
		RELEASE_HELPER_PACKAGE_FILES.has(path) ||
		RUNTIME_PACKAGE_VALIDATOR_FILES.has(path) ||
		RELEASE_HELPER_TEST_FILES.has(path) ||
		isSmokeScript(path)
	);
}

function isReleaseHelperOnlyPath(path) {
	return (
		isCiInfrastructureOnlyPath(path) ||
		path === "scripts/plan-nx-test-command.mjs" ||
		CI_GUARDRAIL_FILES.has(path) ||
		RELEASE_HELPER_PACKAGE_FILES.has(path) ||
		RELEASE_HELPER_TEST_FILES.has(path)
	);
}

export function planCiChecks({ eventName, labels = [], changedFiles = [] }) {
	const normalizedLabels = normalizeLabels(labels);
	const labelSet = new Set(normalizedLabels);
	const isPullRequest = eventName === "pull_request";

	if (!isPullRequest) {
		return {
			ciInfrastructureOnly: false,
			coverage: true,
			lightPrChecks: false,
			releaseHelperOnly: false,
			prChecks: true,
			publicMirror: true,
			rustHostedConformance: true,
			reason: "non_pull_request",
		};
	}

	if (labelSet.has("full-ci")) {
		return {
			ciInfrastructureOnly: false,
			coverage: true,
			lightPrChecks: false,
			releaseHelperOnly: false,
			prChecks: true,
			publicMirror: true,
			rustHostedConformance: true,
			reason: "full_ci_label",
		};
	}

	const files = changedFiles.map(String).map((path) => path.trim()).filter(Boolean);
	const ciInfrastructureOnly =
		files.length > 0 && files.every(isFastPrChecksInfrastructurePath);
	const proofHarnessOnly =
		files.length > 0 && files.every((path) => isProofHarnessPath(path));
	const rustSetupActionChanged = files.some(isRustSetupActionPath);
	const rustOnlySource =
		files.length > 0 && files.every((path) => isRustOnlySourcePath(path));
	const coverage =
		labelSet.has("run-coverage") ||
		(!ciInfrastructureOnly &&
			!rustOnlySource &&
			files.some((path) => !shouldSkipCoverageForPath(path)));
	const prChecks =
		labelSet.has("run-pr-checks") || ciInfrastructureOnly || !rustOnlySource;
	const publicMirror =
		labelSet.has("run-public-mirror") ||
		files.some(
			(path) =>
				!isCiInfrastructureOnlyPath(path) && !shouldSkipPublicMirrorForPath(path),
		);
	const rustHostedConformance =
		labelSet.has("run-rust-hosted-conformance") ||
		rustSetupActionChanged ||
		files.some(isRustHostedConformancePath);
	const releaseHelperWorkflowChanged =
		files.some(isWorkflowFile) &&
		files.some((path) => RELEASE_HELPER_PACKAGE_FILES.has(path));
	const lightPrChecks =
		!coverage &&
		!releaseHelperWorkflowChanged &&
		!rustHostedConformance &&
		files.length > 0 &&
		files.every((path) => isLightPrChecksPath(path));
	const releaseHelperOnly =
		!coverage &&
		!rustHostedConformance &&
		files.length > 0 &&
		files.some(
			(path) =>
				RELEASE_HELPER_PACKAGE_FILES.has(path) ||
				RELEASE_HELPER_TEST_FILES.has(path),
		) &&
		files.every((path) => isReleaseHelperOnlyPath(path));

	return {
		ciInfrastructureOnly,
		coverage,
		lightPrChecks,
		proofHarnessOnly,
		releaseHelperOnly,
		prChecks,
		publicMirror,
		rustHostedConformance,
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
		[
			`coverage=${plan.coverage}`,
			`ci_infrastructure_only=${plan.ciInfrastructureOnly ?? false}`,
			`light_pr_checks=${plan.lightPrChecks ?? false}`,
			`proof_harness_only=${plan.proofHarnessOnly ?? false}`,
			`release_helper_only=${plan.releaseHelperOnly ?? false}`,
			`pr_checks=${plan.prChecks}`,
			`public_mirror=${plan.publicMirror}`,
			`rust_hosted_conformance=${plan.rustHostedConformance}`,
			"",
		].join("\n"),
	);
}

function writeGitHubSummary(plan, changedFiles) {
	if (!process.env.GITHUB_STEP_SUMMARY) {
		return;
	}
	const lines = [
		"## Expensive check plan",
		"",
		`- CI infrastructure only: \`${plan.ciInfrastructureOnly ?? false}\``,
		`- coverage: \`${plan.coverage}\``,
		`- light PR checks: \`${plan.lightPrChecks ?? false}\``,
		`- release helper only: \`${plan.releaseHelperOnly ?? false}\``,
		`- pr checks: \`${plan.prChecks}\``,
		`- public release mirror: \`${plan.publicMirror}\``,
		`- rust hosted conformance: \`${plan.rustHostedConformance}\``,
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
			[
				`coverage=${plan.coverage}`,
				`release_helper_only=${plan.releaseHelperOnly ?? false}`,
				`pr_checks=${plan.prChecks}`,
				`public_mirror=${plan.publicMirror}`,
				`rust_hosted_conformance=${plan.rustHostedConformance}`,
				"",
			].join("\n"),
		);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
