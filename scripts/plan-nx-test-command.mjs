#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

const FORCE_ALL_PATTERNS = [
	/^nx\.json$/,
	/^project\.json$/,
	/^tsconfig\.base\.json$/,
	/^bun\.lockb$/,
	/^package-lock\.json$/,
	/^packages\/[^/]+\/project\.json$/,
];

function parseArgs(argv) {
	const args = {
		base: "",
		head: "",
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--base":
				args.base = argv[++index] ?? "";
				break;
			case "--head":
				args.head = argv[++index] ?? "";
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (!args.base || !args.head) {
		throw new Error("Usage: node scripts/plan-nx-test-command.mjs --base <sha> --head <sha>");
	}

	return args;
}

function stableValue(value) {
	if (Array.isArray(value)) {
		return value.map(stableValue);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, stableValue(child)]),
		);
	}
	return value;
}

function stableJson(value) {
	return JSON.stringify(stableValue(value));
}

function packageJsonScriptsOnlyChanged(basePackage, headPackage) {
	const keys = new Set([
		...Object.keys(basePackage ?? {}),
		...Object.keys(headPackage ?? {}),
	]);

	for (const key of keys) {
		if (key === "scripts") {
			continue;
		}
		if (stableJson(basePackage?.[key]) !== stableJson(headPackage?.[key])) {
			return false;
		}
	}

	return stableJson(basePackage?.scripts) !== stableJson(headPackage?.scripts);
}

function normalizeChangedFiles(changedFiles) {
	return changedFiles
		.map((file) => file.trim())
		.filter(Boolean)
		.sort((left, right) => left.localeCompare(right));
}

export function planNxTestCommand({
	basePackage,
	changedFiles,
	headPackage,
	rootProjectJsonOnlyRemovesTestSelfBuild = false,
}) {
	const normalizedChangedFiles = normalizeChangedFiles(changedFiles);
	const hasPackageJsonChange = normalizedChangedFiles.includes("package.json");
	const packageJsonIsScriptsOnly =
		hasPackageJsonChange &&
		packageJsonScriptsOnlyChanged(basePackage, headPackage);

	const forceAll = normalizedChangedFiles.some((file) => {
		if (file === "package.json" && packageJsonIsScriptsOnly) {
			return false;
		}
		if (file === "project.json" && rootProjectJsonOnlyRemovesTestSelfBuild) {
			return false;
		}
		return file === "package.json" || FORCE_ALL_PATTERNS.some((pattern) => pattern.test(file));
	});

	if (forceAll) {
		return { files: [], mode: "all" };
	}

	const affectedFiles = packageJsonIsScriptsOnly
		? normalizedChangedFiles.filter((file) => file !== "package.json")
		: normalizedChangedFiles;

	if (affectedFiles.length === 0) {
		return { files: [], mode: "none" };
	}

	return { files: affectedFiles, mode: "affected-files" };
}

function git(args) {
	return execFileSync("git", args, { encoding: "utf8" });
}

function readPackageAt(ref) {
	try {
		return JSON.parse(git(["show", `${ref}:package.json`]));
	} catch {
		return null;
	}
}

function rootProjectJsonOnlyRemovesTestSelfBuild(base, head, changedFiles) {
	if (changedFiles.length !== 1 || changedFiles[0] !== "project.json") {
		return false;
	}

	let diff;
	try {
		diff = git(["diff", "--unified=0", base, head, "--", "project.json"]);
	} catch {
		return false;
	}

	const changedLines = diff
		.split("\n")
		.filter((line) => /^[-+][^-+]/.test(line));
	return (
		changedLines.length > 0 &&
		changedLines.every((line) =>
			/^-[\t ]*"dependsOn":[\t ]*\["build"\],?$/.test(line),
		)
	);
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const changedFiles = git(["diff", "--name-only", args.base, args.head])
		.split("\n")
		.filter(Boolean);
	const plan = planNxTestCommand({
		basePackage: readPackageAt(args.base),
		changedFiles,
		headPackage: readPackageAt(args.head),
		rootProjectJsonOnlyRemovesTestSelfBuild:
			rootProjectJsonOnlyRemovesTestSelfBuild(
				args.base,
				args.head,
				changedFiles,
			),
	});

	process.stdout.write(`${plan.mode}\n${plan.files.join(",")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
