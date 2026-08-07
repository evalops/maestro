#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isPublicDocumentationPath } from "./public-documentation-boundary.mjs";

const requiredMirrorExcludes = [
	"docs/**",
	"evals/internal/**",
	"scripts/internal/**",
	"test/internal/**",
];

const forbiddenPublicPaths = [
	"docs/protocols/complex-task-scenarios.md",
	"evals/scenarios/complex-task-gauntlet.json",
	"test/scenario-pack.test.ts",
];

// Internal mirror orchestration legitimately exists in the internal source
// checkout, which is identifiable by the internal-only mirror exclude file.
// These are enforced only when inspecting a public or prepared tree, so the
// documented internal invocation of this checker keeps working.
const forbiddenMirrorOrchestrationPaths = [
	"scripts/check-public-mirror-drift.mjs",
	"scripts/prepare-public-release-mirror.mjs",
	".github/BUGBOT.md",
	".github/PUBLIC_TREE_MIRROR_BOUNDARY.md",
	".github/RELEASE_MIRROR_CONTRACT.md",
	"CLAUDE.md",
];

const forbiddenPublicPathPrefixes = [
	".agents/",
	".context/",
	".github/public-repo/",
];

const forbiddenInternalContentRules = [
	{
		label: "internal work item reference",
		pattern:
			/(?:evalops\/)?maestro-internal(?:\/(?:pull|issues)\/|#)\d+/iu,
	},
	{
		label: "internal Actions run reference",
		pattern: /(?:evalops\/)?maestro-internal(?:\s+run\s+|\/actions\/runs\/)\d+/iu,
	},
	{
		label: "internal cross-repository work item",
		pattern: /evalops\/(?:platform|deploy)#\d+/iu,
	},
	{
		label: "private dependency reference",
		pattern: /github\.com\/evalops\/test-world/iu,
	},
	{
		label: "internal checkout path",
		pattern: /_work\/maestro-internal\//iu,
	},
	{
		label: "private fleet endpoint",
		pattern: /\b192\.168\.4\.(?:53|113)\b/u,
	},
	{
		label: "private runner identity",
		pattern:
			/\bevalops-(?:internal|maestro-internal-rbe|private[-a-z0-9_]*)\b/iu,
	},
	{
		label: "production artifact infrastructure",
		pattern:
			/(?:gs:\/\/evalops-prod-github-actions-evidence|github-actions@evalops-prod\.iam\.gserviceaccount\.com)/iu,
	},
];

const openAiProof = ["OpenAI", "Proof"];
const forbiddenProofArtifactLabels = [
	["Maestro", ...openAiProof].join(" "),
	["COMPUTER", "USE", ...openAiProof.map((term) => term.toUpperCase())].join(
		"_",
	),
	["Maestro", ...openAiProof].join(""),
	["maestro", ...openAiProof.map((term) => term.toLowerCase())].join("-"),
];

const fallbackScanExcludedDirectories = new Set([
	".git",
	".next",
	".nx",
	"build",
	"dist",
	"node_modules",
	"target",
	"tmp",
]);

// The mirror projection never writes .github/workflows/ — the public
// repository owns its CI and release workflows outright and the exclude list
// keeps internal workflows out of the copy plan. Anything under this prefix
// in a public or prepared tree was authored in the public repo, so it is out
// of scope for the internal-content scan (public CI may legitimately
// reference self-hosted runner labels that name the internal fleet).
const internalContentScanExcludedPrefixes = [".github/workflows/"];

function read(path) {
	return readFileSync(resolve(path), "utf8");
}

function filesystemFiles(root = ".") {
	const files = [];
	function walk(relativeDirectory) {
		for (const entry of readdirSync(resolve(relativeDirectory), {
			withFileTypes: true,
		})) {
			const relativePath =
				relativeDirectory === "." ? entry.name : `${relativeDirectory}/${entry.name}`;
			if (entry.isDirectory()) {
				if (!fallbackScanExcludedDirectories.has(entry.name)) {
					walk(relativePath);
				}
				continue;
			}
			if (entry.isFile()) {
				files.push(relativePath);
			}
		}
	}
	walk(root);
	return files;
}

function isGitRepository() {
	try {
		return (
			execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}).trim() === "true"
		);
	} catch {
		return false;
	}
}

function gitProofArtifactErrors() {
	if (!isGitRepository()) {
		return null;
	}
	const matches = [];
	for (const [index, label] of forbiddenProofArtifactLabels.entries()) {
		try {
			const output = execFileSync(
				"git",
				["grep", "--cached", "-n", "-I", "-i", "-F", "-e", label, "--", "."],
				{
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			for (const line of output.split(/\r?\n/u)) {
				const path = line.split(":", 1)[0];
				if (path) {
					matches.push(
						`${path} contains forbidden local proof artifact label variant ${index + 1}`,
					);
				}
			}
		} catch (error) {
			if (error?.status === 1) {
				continue;
			}
			return null;
		}
	}
	return [...new Set(matches)];
}

function filesystemProofArtifactErrors() {
	const matches = [];
	for (const path of filesystemFiles()) {
		const bytes = readFileSync(resolve(path));
		if (bytes.includes(0)) {
			continue;
		}
		const source = bytes.toString("utf8").toLowerCase();
		for (const [index, label] of forbiddenProofArtifactLabels.entries()) {
			if (source.includes(label.toLowerCase())) {
				matches.push(
					`${path} contains forbidden local proof artifact label variant ${index + 1}`,
				);
			}
		}
	}
	return matches;
}

function internalContentErrors() {
	const matches = [];
	for (const path of filesystemFiles()) {
		if (
			internalContentScanExcludedPrefixes.some((prefix) =>
				path.startsWith(prefix),
			)
		) {
			continue;
		}
		const bytes = readFileSync(resolve(path));
		if (bytes.includes(0)) {
			continue;
		}
		const source = bytes.toString("utf8");
		for (const { label, pattern } of forbiddenInternalContentRules) {
			if (pattern.test(source)) {
				matches.push(`${path} contains ${label}`);
			}
		}
	}
	return matches;
}

function docPathAllowlistErrors() {
	const path = "docs/doc-path-allowlist.json";
	if (!existsSync(resolve(path))) {
		return [];
	}
	let entries;
	try {
		entries = JSON.parse(read(path));
	} catch (error) {
		return [`${path} is invalid JSON: ${error.message}`];
	}
	if (!Array.isArray(entries)) {
		return [`${path} must contain a JSON array`];
	}
	return entries
		.filter(
			(entry) =>
				!entry ||
				typeof entry.source !== "string" ||
				!existsSync(resolve(entry.source)),
		)
		.map(
			(entry) =>
				`${path} references non-public source ${JSON.stringify(entry?.source ?? null)}`,
		);
}

function fail(errors) {
	console.error("Public surface boundary check failed:");
	for (const error of errors) {
		console.error(`- ${error}`);
	}
	process.exit(1);
}

const errors = [];
const packageJson = JSON.parse(read("package.json"));
const scripts = packageJson?.scripts ?? {};

for (const [name, command] of Object.entries(scripts)) {
	if (name === "scenario" || name.startsWith("scenario:")) {
		errors.push(`package.json exposes internal scenario script: ${name}`);
	}
	if (String(command).includes("scripts/internal/")) {
		errors.push(`package.json script ${name} references scripts/internal/`);
	}
}

const mirrorExcludePath = ".github/public-release-mirror.exclude";
if (existsSync(resolve(mirrorExcludePath))) {
	const mirrorExclude = read(mirrorExcludePath);
	for (const pattern of requiredMirrorExcludes) {
		if (!mirrorExclude.split(/\r?\n/u).includes(pattern)) {
			errors.push(`${mirrorExcludePath} is missing ${pattern}`);
		}
	}
}

const enforcedForbiddenPaths = existsSync(resolve(mirrorExcludePath))
	? forbiddenPublicPaths
	: [...forbiddenPublicPaths, ...forbiddenMirrorOrchestrationPaths];
for (const path of enforcedForbiddenPaths) {
	if (existsSync(resolve(path))) {
		errors.push(`${path} must not exist in the mirrored public source tree.`);
	}
}

if (!existsSync(resolve(mirrorExcludePath))) {
	for (const path of filesystemFiles()) {
		if (forbiddenPublicPathPrefixes.some((prefix) => path.startsWith(prefix))) {
			errors.push(`${path} must not exist in the mirrored public source tree.`);
		}
		if (!path.startsWith("docs/")) {
			continue;
		}
		if (!isPublicDocumentationPath(path)) {
			errors.push(`${path} is not approved public documentation.`);
		}
	}
	errors.push(...internalContentErrors());
	errors.push(...docPathAllowlistErrors());
}

errors.push(...(gitProofArtifactErrors() ?? filesystemProofArtifactErrors()));

if (errors.length > 0) {
	fail(errors);
}

console.log("Public surface boundary check passed.");
