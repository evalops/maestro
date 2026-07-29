#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_WORKFLOW = resolve(ROOT, ".github/workflows/release.yml");
const RELEASE_SHA_EXPRESSION = "${{ needs.prepare.outputs.release_sha }}";

function indentation(line) {
	return line.match(/^ */u)?.[0].length ?? 0;
}

function scalar(value) {
	return value.trim().replace(/^["']|["']$/gu, "").replace(/\s+#.*$/u, "");
}

export function parseWorkflow(source) {
	const lines = source.replaceAll("\r\n", "\n").split("\n");
	const jobs = {};
	const permissions = {};
	let concurrencyGroup = "";
	let inJobs = false;
	let rootSection = "";
	let job = null;
	let jobSection = "";
	let step = null;
	let stepSection = "";

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const indent = indentation(line);

		if (indent === 0) {
			inJobs = trimmed === "jobs:";
			rootSection = trimmed.endsWith(":") ? trimmed.slice(0, -1) : "";
			job = null;
			continue;
		}
		if (!inJobs) {
			if (indent === 2 && rootSection === "permissions") {
				const permission = /^  ([a-zA-Z0-9_-]+):\s*(\S.*?)\s*$/u.exec(line);
				if (permission) permissions[permission[1]] = scalar(permission[2]);
			}
			if (indent === 2 && rootSection === "concurrency") {
				const group = /^  group:\s*(\S.*?)\s*$/u.exec(line);
				if (group) concurrencyGroup = scalar(group[1]);
			}
			continue;
		}

		const jobMatch = /^  ([a-zA-Z0-9][a-zA-Z0-9_-]*):\s*(?:#.*)?$/u.exec(line);
		if (jobMatch) {
			job = {
				condition: "",
				continueOnError: "",
				environment: "",
				needs: [],
				outputs: {},
				permissions: {},
				runsOn: "",
				steps: [],
			};
			jobs[jobMatch[1]] = job;
			jobSection = "";
			step = null;
			continue;
		}
		if (!job) continue;

		const jobProperty = /^    ([a-zA-Z0-9_-]+):(?:\s*(.*))?$/u.exec(line);
		if (jobProperty) {
			const [, key, rawValue = ""] = jobProperty;
			const value = scalar(rawValue);
			jobSection = key;
			step = null;
			if (key === "environment" && value) job.environment = value;
			if (key === "if" && value) job.condition = value;
			if (key === "continue-on-error" && value) job.continueOnError = value;
			if (key === "runs-on" && value) job.runsOn = value;
			if (key === "needs" && value) {
				job.needs = value.startsWith("[")
					? value
							.slice(1, -1)
							.split(",")
							.map((item) => scalar(item))
							.filter(Boolean)
					: [value];
			}
			continue;
		}

		if (indent === 6 && jobSection === "permissions") {
			const permission = /^      ([a-zA-Z0-9_-]+):\s*(\S.*?)\s*$/u.exec(line);
			if (permission) job.permissions[permission[1]] = scalar(permission[2]);
			continue;
		}
		if (indent === 6 && jobSection === "outputs") {
			const output = /^      ([a-zA-Z0-9_-]+):\s*(\S.*?)\s*$/u.exec(line);
			if (output) job.outputs[output[1]] = scalar(output[2]);
			continue;
		}
		if (indent === 6 && jobSection === "environment") {
			const environmentName = /^      name:\s*(\S.*?)\s*$/u.exec(line);
			if (environmentName) job.environment = scalar(environmentName[1]);
			continue;
		}
		if (indent === 6 && jobSection === "needs") {
			const dependency = /^      -\s*(\S.*?)\s*$/u.exec(line);
			if (dependency) job.needs.push(scalar(dependency[1]));
			continue;
		}
		if (indent === 6 && jobSection === "steps") {
			const stepStart = /^      -\s*([a-zA-Z0-9_-]+):(?:\s*(.*))?$/u.exec(line);
			if (!stepStart) continue;
			step = {
				condition: "",
				continueOnError: "",
				env: {},
				id: "",
				name: "",
				run: "",
				uses: "",
				with: {},
			};
			job.steps.push(step);
			const [, key, rawValue = ""] = stepStart;
			step[key] = scalar(rawValue);
			stepSection = "";
			continue;
		}
		if (!step || indent < 8) continue;

		const stepProperty = /^        ([a-zA-Z0-9_-]+):(?:\s*(.*))?$/u.exec(line);
		if (stepProperty) {
			const [, key, rawValue = ""] = stepProperty;
			const value = scalar(rawValue);
			stepSection = key;
			if (key === "run" && (value === "|" || value === ">")) {
				const script = [];
				while (index + 1 < lines.length) {
					const next = lines[index + 1];
					if (next.trim() && indentation(next) <= 8) break;
					index += 1;
					script.push(next.length >= 10 ? next.slice(10) : "");
				}
				step.run = script.join("\n");
			} else if (key === "if") {
				step.condition = value;
			} else if (key === "continue-on-error") {
				step.continueOnError = value;
			} else if (key in step && value) {
				step[key] = value;
			}
			continue;
		}
		if (indent === 10 && (stepSection === "env" || stepSection === "with")) {
			const entry = /^          ([a-zA-Z0-9_-]+):\s*(.*?)\s*$/u.exec(line);
			if (entry) step[stepSection][entry[1]] = scalar(entry[2]);
		}
	}

	return { concurrencyGroup, jobs, permissions };
}

function hasNeed(job, dependency) {
	return job?.needs.includes(dependency) ?? false;
}

function checkoutIsBound(job) {
	const checkouts =
		job?.steps.filter((step) => step.uses.startsWith("actions/checkout@")) ?? [];
	return (
		checkouts.length === 1 &&
		!checkouts[0].condition &&
		(!checkouts[0].continueOnError || checkouts[0].continueOnError === "false") &&
		checkouts[0].with.ref === RELEASE_SHA_EXPRESSION
	);
}

function requiredStepCanBeSkippedOrIgnored(step) {
	return Boolean(
		step?.condition ||
			(step?.continueOnError && step.continueOnError !== "false"),
	);
}

function hasExactPermissions(actual, expected) {
	const actualEntries = Object.entries(actual).sort(([left], [right]) =>
		left.localeCompare(right),
	);
	const expectedEntries = Object.entries(expected).sort(([left], [right]) =>
		left.localeCompare(right),
	);
	return JSON.stringify(actualEntries) === JSON.stringify(expectedEntries);
}

function hasExactRecord(actual, expected) {
	const actualEntries = Object.entries(actual).sort(([left], [right]) =>
		left.localeCompare(right),
	);
	const expectedEntries = Object.entries(expected).sort(([left], [right]) =>
		left.localeCompare(right),
	);
	return JSON.stringify(actualEntries) === JSON.stringify(expectedEntries);
}

function executableLines(script) {
	return script
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"));
}

function topLevelExecutableLines(script) {
	return script
		.split("\n")
		.filter((line) => line && !/^\s/u.test(line) && !line.startsWith("#"));
}

function findStep(job, name) {
	return job?.steps.find((step) => step.name === name);
}

export function validateReleaseWorkflow(source) {
	const { concurrencyGroup, jobs, permissions } = parseWorkflow(source);
	const failures = [];
	const prepare = jobs.prepare;
	const binaries = jobs.binaries;
	const publish = jobs.publish;
	const release = jobs["github-release"];
	const canary = jobs["post-publish-canary"];

	for (const [name, job] of [
		["prepare", prepare],
		["binaries", binaries],
		["publish", publish],
		["github-release", release],
		["post-publish-canary", canary],
	]) {
		if (!job) failures.push(`missing ${name} job`);
	}
	if (!prepare || !binaries || !publish || !release || !canary) return failures;

	if (!hasExactPermissions(permissions, { contents: "read" })) {
		failures.push("workflow default permissions must be exactly contents: read");
	}
	const normalizedReleaseConcurrency =
		"${{ github.workflow }}-${{ github.event_name == 'workflow_dispatch' && (startsWith(inputs.version, 'v') && inputs.version || format('v{0}', inputs.version)) || github.ref_name }}";
	if (concurrencyGroup !== normalizedReleaseConcurrency) {
		failures.push(
			"release workflows must serialize only duplicate paths for the same normalized release tag",
		);
	}
	for (const [name, job] of [
		["prepare", prepare],
		["binaries", binaries],
		["post-publish-canary", canary],
	]) {
		if (!hasExactPermissions(job.permissions, { contents: "read" })) {
			failures.push(`${name} permissions must be exactly contents: read`);
		}
	}
	if (
		!hasExactPermissions(publish.permissions, {
			contents: "read",
			"id-token": "write",
		})
	) {
		failures.push(
			"publish permissions must be exactly contents: read and id-token: write",
		);
	}
	if (!hasExactPermissions(release.permissions, { contents: "write" })) {
		failures.push("github-release permissions must be exactly contents: write");
	}
	for (const [name, job] of [
		["prepare", prepare],
		["binaries", binaries],
		["publish", publish],
		["github-release", release],
		["post-publish-canary", canary],
	]) {
		if (
			job.condition ||
			(job.continueOnError && job.continueOnError !== "false")
		) {
			failures.push(`${name} job must not be conditional or ignored`);
		}
	}
	for (const [name, job] of [
		["prepare", prepare],
		["publish", publish],
		["github-release", release],
		["post-publish-canary", canary],
	]) {
		if (job.runsOn !== "${{ vars.INTERNAL_CONFIRMATION_RUNNER }}") {
			failures.push(`${name} must run on INTERNAL_CONFIRMATION_RUNNER`);
		}
	}

	const resolveStep = findStep(prepare, "Resolve immutable release tag");
	const prepareCheckout = prepare.steps.find((step) =>
		step.uses.startsWith("actions/checkout@"),
	);
	if (prepareCheckout?.with["fetch-depth"] !== "1") {
		failures.push(
			"prepare checkout must be shallow before the bounded immutable tag fetch",
		);
	}
	const resolveLines = executableLines(resolveStep?.run ?? "");
	const topLevelResolveLines = topLevelExecutableLines(resolveStep?.run ?? "");
	if (resolveStep?.id !== "release") {
		failures.push("immutable resolver step id must be release");
	}
	if (
		!hasExactRecord(prepare.outputs, {
			package_name: "${{ steps.release.outputs.package_name }}",
			release_sha: "${{ steps.release.outputs.release_sha }}",
			release_tag: "${{ steps.release.outputs.release_tag }}",
			release_version: "${{ steps.release.outputs.release_version }}",
		})
	) {
		failures.push("prepare outputs must bind exactly to the immutable resolver");
	}
	if (requiredStepCanBeSkippedOrIgnored(resolveStep)) {
		failures.push("immutable release resolution must not be conditional or ignored");
	}
	for (const command of [
		'release_sha="$(git rev-list -n 1 "$release_tag")"',
		'git checkout --detach "$release_sha"',
	]) {
		if (!resolveLines.includes(command) || !topLevelResolveLines.includes(command)) {
			failures.push(`immutable release resolution is missing: ${command}`);
		}
	}
	const boundedFetch =
		'fetch --force --no-tags origin "refs/tags/${release_tag}:refs/tags/${release_tag}"; then';
	if (
		!resolveLines.includes("for attempt in 1 2 3; do") ||
		!resolveLines.includes("if timeout 60s git \\") ||
		!resolveLines.includes("-c http.lowSpeedLimit=1000 \\") ||
		!resolveLines.includes("-c http.lowSpeedTime=30 \\") ||
		!resolveLines.includes(boundedFetch) ||
		!resolveLines.includes('if [[ "$attempt" -eq 3 ]]; then') ||
		!resolveLines.includes("sleep 2")
	) {
		failures.push("immutable tag fetch must use bounded retries and transport timeouts");
	}
	for (const output of [
		"package_name",
		"release_sha",
		"release_tag",
		"release_version",
	]) {
		if (
			resolveLines.filter((line) => line.startsWith(`echo "${output}=`))
				.length !== 1 ||
			!resolveLines.includes(`echo "${output}=$${output}"`)
		) {
			failures.push(`immutable resolver must emit ${output} exactly once`);
		}
	}
	if (
		resolveLines.filter((line) => line.includes("GITHUB_OUTPUT")).length !== 1 ||
		!resolveLines.includes('} >> "$GITHUB_OUTPUT"')
	) {
		failures.push("immutable resolver outputs must use one grouped GITHUB_OUTPUT write");
	}

	if (!hasNeed(binaries, "prepare")) failures.push("binaries must need prepare");
	if (!hasNeed(publish, "prepare") || !hasNeed(publish, "binaries")) {
		failures.push("publish must need prepare and binaries");
	}
	if (
		!hasNeed(release, "prepare") ||
		!hasNeed(release, "binaries") ||
		!hasNeed(release, "publish")
	) {
		failures.push("github-release must need prepare, binaries, and publish");
	}
	if (!hasNeed(canary, "prepare") || !hasNeed(canary, "publish")) {
		failures.push("post-publish canary must need prepare and publish");
	}
	for (const [name, job] of [
		["binaries", binaries],
		["publish", publish],
		["post-publish-canary", canary],
	]) {
		if (!checkoutIsBound(job)) {
			failures.push(`${name} checkout must bind to the immutable release SHA`);
		}
	}

	if (publish.environment !== "npm-release") {
		failures.push("publish must use the npm-release environment");
	}
	if (publish.permissions["id-token"] !== "write") {
		failures.push("publish must grant id-token: write for trusted publishing");
	}
	const assetStep = findStep(publish, "Verify native package inputs");
	if (requiredStepCanBeSkippedOrIgnored(assetStep)) {
		failures.push("native package input verification must not be conditional or ignored");
	}
	if (
		JSON.stringify(executableLines(assetStep?.run ?? "")) !==
		JSON.stringify([
			"set -euo pipefail",
			`test "$(node -p "require('./package.json').version")" = "$RELEASE_VERSION"`,
			"test -f packages/web/dist/index.html",
			"npm run check:rust-only-runtime",
		])
	) {
		failures.push("publish must execute the exact native package input checks");
	}

	const publishStep = findStep(publish, "Publish to npm");
	const publishLines = executableLines(publishStep?.run ?? "");
	const topLevelPublishLines = topLevelExecutableLines(publishStep?.run ?? "");
	if (requiredStepCanBeSkippedOrIgnored(publishStep)) {
		failures.push("npm publication must not be conditional or ignored");
	}
	if (!topLevelPublishLines.includes('case "$NPM_PUBLISH_AUTH_MODE" in')) {
		failures.push("npm auth-mode dispatch must execute at the top shell level");
	}
	const authCaseIndex = topLevelPublishLines.indexOf(
		'case "$NPM_PUBLISH_AUTH_MODE" in',
	);
	if (
		topLevelPublishLines
			.slice(0, authCaseIndex)
			.some((line) => /^(?:exit|return)(?:\s|$)/u.test(line)) ||
		publishLines.some((line) => /^npm\s*\(\)\s*\{/u.test(line)) ||
		publishLines.some((line) => line === "return 0")
	) {
		failures.push("npm auth-mode dispatch must not be bypassed before publication");
	}
	const unsupportedIndex = publishLines.indexOf("*)");
	if (
		unsupportedIndex < 0 ||
		publishLines[unsupportedIndex + 1] !==
			`echo "::error::Unsupported NPM_PUBLISH_AUTH_MODE '$NPM_PUBLISH_AUTH_MODE'. Use auto, trusted, or token."` ||
		publishLines[unsupportedIndex + 2] !== "exit 1" ||
		publishLines.filter((line) => line === "exit 1").length !== 1
	) {
		failures.push("unsupported npm auth modes must terminate with failure");
	}
	const trustedCalls = publishLines.filter(
		(line) => line === "publish_with_trusted_publisher",
	).length;
	const guardedTrustedCalls = publishLines.filter(
		(line) =>
			line === "publish_with_trusted_publisher || trusted_status=$?",
	).length;
	const tokenCalls = publishLines.filter(
		(line) => line === "publish_with_token",
	).length;
	const npmPublishLines = publishLines.filter((line) =>
		line.startsWith("command npm publish "),
	);
	const expectedPublishLines = new Set([
		'command npm publish "${{ steps.pack.outputs.tarball }}" --access public --provenance',
		'command npm publish "${{ steps.pack.outputs.tarball }}" --access public',
	]);
	if (guardedTrustedCalls !== 1 || trustedCalls < 1 || tokenCalls < 2) {
		failures.push("npm publish helpers must be invoked in auto, trusted, and token modes");
	}
	if (
		npmPublishLines.length !== expectedPublishLines.size ||
		npmPublishLines.some((line) => !expectedPublishLines.has(line))
	) {
		failures.push("trusted and token modes must execute exact unswallowed npm publish commands");
	}
	if (
		publishStep?.env.NPM_PUBLISH_AUTH_MODE !==
		"${{ vars.NPM_PUBLISH_AUTH_MODE || 'auto' }}"
	) {
		failures.push("publish must expose the governed NPM_PUBLISH_AUTH_MODE");
	}
	const boundedNpmEnv = {
		NPM_CONFIG_FETCH_RETRIES: "1",
		NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT: "2000",
		NPM_CONFIG_FETCH_RETRY_MINTIMEOUT: "1000",
		NPM_CONFIG_FETCH_TIMEOUT: "30000",
	};
	for (const [name, step] of [
		["publish", publishStep],
		["packed-package smoke", findStep(publish, "Smoke packed package without JS runtime")],
		["post-publish canary", findStep(canary, "Verify published package from npm")],
	]) {
		for (const [key, value] of Object.entries(boundedNpmEnv)) {
			if (step?.env[key] !== value) {
				failures.push(`${name} must set bounded npm network configuration`);
				break;
			}
		}
	}

	const releaseSteps = Object.values(jobs).flatMap((job) =>
		job.steps.filter((step) =>
			step.uses.startsWith("softprops/action-gh-release@"),
		),
	);
	const releaseStep = releaseSteps[0];
	if (releaseSteps.length !== 1) {
		failures.push("workflow must contain exactly one GitHub release action");
	}
	if (!release.steps.includes(releaseStep)) {
		failures.push("GitHub release action must run in the retryable github-release job");
	}
	if (requiredStepCanBeSkippedOrIgnored(releaseStep)) {
		failures.push("GitHub release creation must not be conditional or ignored");
	}
	if (
		releaseStep?.with.tag_name !==
			"${{ needs.prepare.outputs.release_tag }}" ||
		releaseStep?.with.name !==
			"Maestro ${{ needs.prepare.outputs.release_version }}" ||
		releaseStep?.with.files !== "release-assets/*"
	) {
		failures.push(
			"GitHub release metadata and files must bind to immutable prepare outputs",
		);
	}
	const publishUploads = publish.steps.filter((step) =>
		step.uses.startsWith("actions/upload-artifact@"),
	);
	for (const artifactName of [
		"npm-tarball-${{ needs.prepare.outputs.release_tag }}",
		"release-web-dist-${{ needs.prepare.outputs.release_tag }}",
	]) {
		if (
			!publishUploads.some(
				(step) =>
					step.with.name === artifactName && step.with.overwrite === "true",
			)
		) {
			failures.push(`publish must persist retryable artifact ${artifactName}`);
		}
	}
	const releaseDownloads = release.steps.filter((step) =>
		step.uses.startsWith("actions/download-artifact@"),
	);
	if (
		releaseDownloads.length !== 3 ||
		!releaseDownloads.some(
			(step) =>
				step.with.name ===
					"npm-tarball-${{ needs.prepare.outputs.release_tag }}" &&
				step.with.path === "release-assets",
		) ||
		!releaseDownloads.some(
			(step) =>
				step.with.pattern === "maestro-*" &&
				step.with.path === "release-assets" &&
				step.with["merge-multiple"] === "true",
		) ||
		!releaseDownloads.some(
			(step) =>
				step.with.name ===
					"release-web-dist-${{ needs.prepare.outputs.release_tag }}" &&
				step.with.path === "release-assets",
		)
	) {
		failures.push("github-release must restore the exact immutable release artifacts");
	}
	const canaryStep = findStep(canary, "Verify published package from npm");
	const canaryLines = executableLines(canaryStep?.run ?? "");
	if (requiredStepCanBeSkippedOrIgnored(canaryStep)) {
		failures.push("registry canary must not be conditional or ignored");
	}
	const expectedCanaryLines = [
		"set -euo pipefail",
		"node scripts/smoke-registry-install.js \\",
		'--package "$PACKAGE_NAME" \\',
		'--version "$RELEASE_VERSION" \\',
		'--cli-command "$CLI_COMMAND"',
	];
	if (JSON.stringify(canaryLines) !== JSON.stringify(expectedCanaryLines)) {
		failures.push("post-publish canary must execute only the exact registry smoke");
	}
	if (
		canaryStep?.env.PACKAGE_NAME !==
			"${{ needs.prepare.outputs.package_name }}" ||
		canaryStep?.env.RELEASE_VERSION !==
			"${{ needs.prepare.outputs.release_version }}"
	) {
		failures.push("registry canary must bind package and version to prepare outputs");
	}
	const replayStep = findStep(canary, "Validate published replay evidence");
	if (!replayStep) {
		failures.push("post-publish canary must validate replay evidence");
	} else if (requiredStepCanBeSkippedOrIgnored(replayStep)) {
		failures.push("published replay validation must not be conditional or ignored");
	} else if (
		JSON.stringify(executableLines(replayStep.run)) !==
		JSON.stringify([
			"node scripts/verify-published-replay-evidence.js --evidence-dir published-replay-evidence",
		])
	) {
		failures.push("published replay validation must execute the exact evidence verifier");
	}
	const replayUpload = findStep(canary, "Upload published replay evidence");
	if (
		!replayUpload?.uses.startsWith("actions/upload-artifact@") ||
		replayUpload.with.name !==
			"published-replay-evidence-${{ needs.prepare.outputs.release_tag }}" ||
		replayUpload.with.path !== "published-replay-evidence/*.json" ||
		replayUpload.with.overwrite !== "true"
	) {
		failures.push(
			"post-publish canary must replace exact-tag replay evidence on reruns",
		);
	}

	return failures;
}

export async function checkReleaseWorkflow(path = DEFAULT_WORKFLOW) {
	const source = await readFile(path, "utf8");
	return validateReleaseWorkflow(source);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const failures = await checkReleaseWorkflow();
	if (failures.length > 0) {
		console.error("Release workflow contract check failed:");
		for (const failure of failures) console.error(`- ${failure}`);
		process.exitCode = 1;
	} else {
		console.log("Release workflow contract check passed.");
	}
}
