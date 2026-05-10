#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const registryPath = "docs/CONVENTIONS/staged-rollout-registry.json";

const riskySurfacePatterns = [
	/^proto\/maestro\/v1\/headless\.proto$/,
	/^src\/cli\/args\.ts$/,
	/^src\/cli\/help\.ts$/,
	/^src\/cli\/headless-protocol\.ts$/,
	/^src\/cli\/headless-runtime-selection\.ts$/,
	/^src\/cli\/commands\//,
	/^src\/cli-tui\/commands\//,
	/^src\/agent\/modes\.ts$/,
	/^src\/config\//,
	/^packages\/contracts\/src\/headless-protocol/,
];

const stagedRolloutAnswerPattern =
	/staged[- ]rollout|staged rollout choice|direct exposure safe|staging is unnecessary|hidden flag|hidden mode|enabling primitive/i;
const stagedRolloutTemplatePromptPattern =
	/if this pr adds or promotes user-visible behavior,\s*explain the staged-rollout choice \(or why staging is unnecessary\)\.?/i;

const surfaceTypePolicies = new Map([
	["hidden_cli_flag", { requiresTelemetry: true }],
	["hidden_mode", { requiresTelemetry: true }],
	["internal_gate", { requiresTelemetry: true }],
	["protocol_capability", { requiresTelemetry: false }],
]);

const allowedSurfaceTypes = new Set(surfaceTypePolicies.keys());
const allowedStatuses = new Set([
	"experimental",
	"indefinite-internal",
	"enabling-primitive",
]);
const introducedDatePattern = /^\d{4}-\d{2}-\d{2}$/;

export function isRiskySurfacePath(path) {
	return riskySurfacePatterns.some((pattern) => pattern.test(path));
}

export function riskySurfaceFiles(paths) {
	return paths.filter(isRiskySurfacePath);
}

export function hasStagedRolloutAnswer(body) {
	const answerText = String(body ?? "")
		.split("\n")
		.filter((line) => {
			if (!stagedRolloutTemplatePromptPattern.test(line)) return true;
			const [, afterPrompt = ""] = line.split(stagedRolloutTemplatePromptPattern);
			return afterPrompt.replace(/^[\s.:-]+/, "").trim().length > 0;
		})
		.join("\n");
	return stagedRolloutAnswerPattern.test(answerText);
}

export function validateRegistry(registry) {
	const failures = [];
	if (!registry || typeof registry !== "object") {
		return ["registry must be a JSON object"];
	}
	if (!Array.isArray(registry.surfaces)) {
		return ["registry.surfaces must be an array"];
	}

	const ids = new Set();
	for (const [index, surface] of registry.surfaces.entries()) {
		const label =
			surface && typeof surface.id === "string"
				? surface.id
				: `surfaces[${index}]`;
		for (const field of [
			"id",
			"type",
			"owner",
			"introduced_in",
			"status",
			"target",
			"rationale",
		]) {
			if (typeof surface?.[field] !== "string" || surface[field].trim() === "") {
				failures.push(`${label}: missing non-empty ${field}`);
			}
		}
		if (typeof surface?.id === "string") {
			if (ids.has(surface.id)) {
				failures.push(`${label}: duplicate id`);
			}
			ids.add(surface.id);
		}
		if (
			typeof surface?.type === "string" &&
			!allowedSurfaceTypes.has(surface.type)
		) {
			failures.push(`${label}: unknown type ${surface.type}`);
		}
		if (
			typeof surface?.introduced_in === "string" &&
			!introducedDatePattern.test(surface.introduced_in)
		) {
			failures.push(`${label}: introduced_in must be YYYY-MM-DD`);
		}
		if (
			typeof surface?.status === "string" &&
			!allowedStatuses.has(surface.status)
		) {
			failures.push(`${label}: unknown status ${surface.status}`);
		}
		if (
			surfaceTypePolicies.get(surface?.type)?.requiresTelemetry === true &&
			(typeof surface?.telemetry_event !== "string" ||
				surface.telemetry_event.trim() === "")
		) {
			failures.push(`${label}: hidden/internal surfaces require telemetry_event`);
		}
		if (
			surface?.status === "indefinite-internal" &&
			typeof surface?.rationale === "string" &&
			surface.rationale.trim().length < 20
		) {
			failures.push(`${label}: indefinite-internal rationale is too short`);
		}
	}

	return failures;
}

export function readPullRequestBodyFromEvent(eventPath) {
	if (!eventPath || !existsSync(eventPath)) return "";
	const event = JSON.parse(readFileSync(eventPath, "utf8"));
	return event?.pull_request?.body ?? "";
}

function parseArgs(argv) {
	const options = {
		base: process.env.BASE_SHA ?? process.env.NX_BASE,
		head: process.env.HEAD_SHA ?? process.env.NX_HEAD ?? "HEAD",
		prBody: undefined,
		prBodyFile: undefined,
		changedFile: [],
	};

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		switch (arg) {
			case "--base":
				options.base = argv[++index];
				break;
			case "--head":
				options.head = argv[++index];
				break;
			case "--pr-body":
				options.prBody = argv[++index] ?? "";
				break;
			case "--pr-body-file":
				options.prBodyFile = argv[++index];
				break;
			case "--changed-file":
				options.changedFile.push(argv[++index]);
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	return options;
}

export function defaultDiffBase(env = process.env) {
	const baseRef = env.GITHUB_BASE_REF?.trim();
	if (baseRef) {
		return `origin/${baseRef}`;
	}
	const refName = env.GITHUB_REF_NAME?.trim();
	if (refName && refName !== "main") {
		return "origin/main";
	}
	return "";
}

function changedFilesFromGit(options) {
	if (options.changedFile.length > 0) {
		return options.changedFile.filter(Boolean);
	}
	const base = options.base || defaultDiffBase();
	if (!base) {
		return [];
	}
	const output = execFileSync(
		"git",
		["diff", "--name-only", `${base}...${options.head}`],
		{ cwd: root, encoding: "utf8" },
	);
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

function resolvePrBody(options) {
	if (options.prBody !== undefined) return options.prBody;
	if (options.prBodyFile) return readFileSync(options.prBodyFile, "utf8");
	return readPullRequestBodyFromEvent(process.env.GITHUB_EVENT_PATH);
}

export function evaluateStagedRolloutCheck({
	registry,
	changedFiles,
	prBody,
	isPullRequest,
}) {
	const failures = validateRegistry(registry);
	const riskyFiles = riskySurfaceFiles(changedFiles);
	if (isPullRequest && riskyFiles.length > 0 && !hasStagedRolloutAnswer(prBody)) {
		failures.push(
			`risky staged-rollout surfaces changed without a staged-rollout PR-body answer: ${riskyFiles.join(", ")}`,
		);
	}
	return { failures, riskyFiles };
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const registry = JSON.parse(readFileSync(join(root, registryPath), "utf8"));
	const changedFiles = changedFilesFromGit(options);
	const prBody = resolvePrBody(options);
	const isPullRequest =
		process.env.GITHUB_EVENT_NAME === "pull_request" ||
		process.env.GITHUB_EVENT_NAME === "pull_request_target" ||
		prBody.length > 0;

	const { failures, riskyFiles } = evaluateStagedRolloutCheck({
		registry,
		changedFiles,
		prBody,
		isPullRequest,
	});

	if (failures.length > 0) {
		console.error("staged rollout check failed:");
		for (const failure of failures) {
			console.error(`  - ${failure}`);
		}
		process.exit(1);
	}

	const suffix =
		riskyFiles.length > 0
			? ` (${riskyFiles.length} risky changed file${riskyFiles.length === 1 ? "" : "s"})`
			: "";
	console.log(`staged rollout check passed${suffix}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
