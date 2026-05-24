#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const requiredMirrorExcludes = [
	"docs/internal/**",
	"evals/internal/**",
	"scripts/internal/**",
	"test/internal/**",
];

const forbiddenPublicPaths = [
	"docs/protocols/complex-task-scenarios.md",
	"evals/scenarios/complex-task-gauntlet.json",
	"test/scenario-pack.test.ts",
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

for (const path of forbiddenPublicPaths) {
	if (existsSync(resolve(path))) {
		errors.push(`${path} must not exist in the mirrored public source tree.`);
	}
}

errors.push(...(gitProofArtifactErrors() ?? filesystemProofArtifactErrors()));

if (errors.length > 0) {
	fail(errors);
}

console.log("Public surface boundary check passed.");
