#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { getRuntimeWorkspacePackages } from "./runtime-workspaces.mjs";

const FORCE_ALL_PATTERNS = [
	/^nx\.json$/,
	/^project\.json$/,
	/^tsconfig\.base\.json$/,
	/^bun\.lockb$/,
	/^package-lock\.json$/,
	/^packages\/[^/]+\/project\.json$/,
];
const PACKAGE_MANIFEST_PATTERN = /^packages\/[^/]+\/package\.json$/;
const RELEASE_METADATA_FILES = new Set(["CHANGELOG.md"]);
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
	"scripts/smoke-packed-cli.js",
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
const SMOKE_SCRIPT_PATTERN = /^scripts\/smoke-[^/]+\.[cm]?[jt]sx?$/;

function parseArgs(argv) {
	const args = {
		base: "",
		head: "",
		runtimePackageValidators: false,
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
			case "--runtime-package-validators":
				args.runtimePackageValidators = true;
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

function asStringSet(value) {
	return new Set(
		(Array.isArray(value) ? value : [])
			.filter((item) => typeof item === "string" && item.length > 0)
			.sort(),
	);
}

function setEquals(left, right) {
	if (left.size !== right.size) {
		return false;
	}
	for (const value of left) {
		if (!right.has(value)) {
			return false;
		}
	}
	return true;
}

function clonePackage(pkg) {
	return pkg && typeof pkg === "object"
		? JSON.parse(JSON.stringify(pkg))
		: {};
}

function normalizeDependencySection({
	allowedAddedNames,
	basePackage,
	headPackage,
	section,
}) {
	const baseSection =
		basePackage[section] && typeof basePackage[section] === "object"
			? basePackage[section]
			: undefined;
	const headSection =
		headPackage[section] && typeof headPackage[section] === "object"
			? headPackage[section]
			: undefined;
	const names = new Set([
		...Object.keys(baseSection ?? {}),
		...Object.keys(headSection ?? {}),
	]);

	for (const name of names) {
		const baseHas = Boolean(baseSection && Object.hasOwn(baseSection, name));
		const headHas = Boolean(headSection && Object.hasOwn(headSection, name));
		if (name.startsWith("@evalops/") && baseHas && headHas) {
			baseSection[name] = "__internal_workspace_version__";
			headSection[name] = "__internal_workspace_version__";
			continue;
		}
		if (!baseHas && headHas && allowedAddedNames.has(name)) {
			delete headSection[name];
		}
	}
}

function removeEmptyDependencySections(pkg) {
	for (const section of [
		"dependencies",
		"devDependencies",
		"optionalDependencies",
		"peerDependencies",
	]) {
		if (
			pkg[section] &&
			typeof pkg[section] === "object" &&
			Object.keys(pkg[section]).length === 0
		) {
			delete pkg[section];
		}
	}
}

function normalizeRuntimeWorkspaceMetadata(basePackage, headPackage) {
	const baseRuntimeWorkspaces = asStringSet(
		basePackage.maestroRuntimeWorkspaces ?? basePackage.bundleDependencies,
	);
	const headRuntimeWorkspaces = asStringSet(
		headPackage.maestroRuntimeWorkspaces ?? headPackage.bundleDependencies,
	);
	if (!setEquals(baseRuntimeWorkspaces, headRuntimeWorkspaces)) {
		return;
	}

	delete basePackage.bundleDependencies;
	delete basePackage.bundledDependencies;
	delete basePackage.maestroRuntimeWorkspaces;
	delete headPackage.bundleDependencies;
	delete headPackage.bundledDependencies;
	delete headPackage.maestroRuntimeWorkspaces;
}

export function packageManifestReleaseMetadataOnlyChanged({
	allowedRootDependencyNames = [],
	basePackage,
	headPackage,
	isRootPackage = false,
}) {
	const normalizedBase = clonePackage(basePackage);
	const normalizedHead = clonePackage(headPackage);
	const allowedAddedNames = new Set(
		isRootPackage ? allowedRootDependencyNames : [],
	);

	delete normalizedBase.version;
	delete normalizedHead.version;

	if (isRootPackage) {
		normalizeRuntimeWorkspaceMetadata(normalizedBase, normalizedHead);
	}

	for (const section of [
		"dependencies",
		"devDependencies",
		"optionalDependencies",
		"peerDependencies",
	]) {
		normalizeDependencySection({
			allowedAddedNames,
			basePackage: normalizedBase,
			headPackage: normalizedHead,
			section,
		});
	}

	removeEmptyDependencySections(normalizedBase);
	removeEmptyDependencySections(normalizedHead);

	return stableJson(normalizedBase) === stableJson(normalizedHead);
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

function isHandledOutsideNx(file) {
	return (
		CI_GUARDRAIL_FILES.has(file) ||
		RELEASE_HELPER_PACKAGE_FILES.has(file) ||
		RUNTIME_PACKAGE_VALIDATOR_FILES.has(file) ||
		SMOKE_SCRIPT_PATTERN.test(file) ||
		(file.startsWith("docs/") && file.endsWith(".md")) ||
		file.startsWith(".github/workflows/")
	);
}

export function planNxTestCommand({
	basePackage,
	changedFiles,
	headPackage,
	handledOutsideNxFiles,
	packageJsonMetadataOnlyFiles = [],
	releaseMetadataOnlyFiles = [],
	rootProjectJsonOnlyRemovesTestSelfBuild = false,
}) {
	const normalizedChangedFiles = normalizeChangedFiles(changedFiles);
	const hasPackageJsonChange = normalizedChangedFiles.includes("package.json");
	const handledOutsideNxSet = new Set(
		handledOutsideNxFiles ?? normalizedChangedFiles.filter(isHandledOutsideNx),
	);
	const packageJsonMetadataOnlySet = new Set(packageJsonMetadataOnlyFiles);
	const releaseMetadataOnlySet = new Set(releaseMetadataOnlyFiles);
	const packageJsonIsScriptsOnly =
		hasPackageJsonChange &&
		packageJsonScriptsOnlyChanged(basePackage, headPackage);
	const isFilteredMetadataOnlyFile = (file) =>
		(file === "package.json" &&
			(packageJsonIsScriptsOnly || packageJsonMetadataOnlySet.has(file))) ||
		(PACKAGE_MANIFEST_PATTERN.test(file) &&
			packageJsonMetadataOnlySet.has(file)) ||
		releaseMetadataOnlySet.has(file) ||
		handledOutsideNxSet.has(file);

	const forceAll = normalizedChangedFiles.some((file) => {
		if (isFilteredMetadataOnlyFile(file)) {
			return false;
		}
		if (file === "project.json" && rootProjectJsonOnlyRemovesTestSelfBuild) {
			return false;
		}
		return (
			file === "package.json" ||
			FORCE_ALL_PATTERNS.some((pattern) => pattern.test(file))
		);
	});

	if (forceAll) {
		return { files: [], mode: "all" };
	}

	const affectedFiles = normalizedChangedFiles.filter(
		(file) => !isFilteredMetadataOnlyFile(file),
	);

	if (affectedFiles.length === 0) {
		return { files: [], mode: "none" };
	}

	return { files: affectedFiles, mode: "affected-files" };
}

export function runtimePackageValidatorsRequired({
	basePackage,
	changedFiles,
	headPackage,
	packageJsonMetadataOnlyFiles = [],
}) {
	const normalizedChangedFiles = normalizeChangedFiles(changedFiles);
	const packageJsonMetadataOnlySet = new Set(packageJsonMetadataOnlyFiles);
	const packageJsonIsScriptsOnly =
		normalizedChangedFiles.includes("package.json") &&
		packageJsonScriptsOnlyChanged(basePackage, headPackage);

	return normalizedChangedFiles.some((file) => {
		if (RUNTIME_PACKAGE_VALIDATOR_FILES.has(file)) {
			return true;
		}
		if (file === "package.json") {
			return !(packageJsonIsScriptsOnly || packageJsonMetadataOnlySet.has(file));
		}
		if (PACKAGE_MANIFEST_PATTERN.test(file)) {
			return !packageJsonMetadataOnlySet.has(file);
		}
		return false;
	});
}

function git(args) {
	return execFileSync("git", args, { encoding: "utf8" });
}

function readPackageAt(ref) {
	return readJsonAt(ref, "package.json");
}

function readJsonAt(ref, path) {
	try {
		return JSON.parse(git(["show", `${ref}:${path}`]));
	} catch {
		return null;
	}
}

function openApiInfoVersionOnlyChanged(base, head) {
	const normalizedBase = clonePackage(base);
	const normalizedHead = clonePackage(head);
	if (
		normalizedBase.info &&
		typeof normalizedBase.info === "object" &&
		normalizedHead.info &&
		typeof normalizedHead.info === "object"
	) {
		delete normalizedBase.info.version;
		delete normalizedHead.info.version;
	}
	return stableJson(normalizedBase) === stableJson(normalizedHead);
}

async function runtimeWorkspaceDependencyNames(rootPackage) {
	if (!rootPackage || typeof rootPackage !== "object") {
		return [];
	}
	const names = new Set();
	for (const workspacePackage of await getRuntimeWorkspacePackages(rootPackage)) {
		for (const section of [
			"dependencies",
			"optionalDependencies",
			"peerDependencies",
		]) {
			const deps = workspacePackage.data[section];
			if (!deps || typeof deps !== "object" || Array.isArray(deps)) {
				continue;
			}
			for (const name of Object.keys(deps)) {
				names.add(name);
			}
		}
	}
	return Array.from(names).sort();
}

async function metadataOnlyPackageFiles(base, head, changedFiles, headPackage) {
	const allowedRootDependencyNames = await runtimeWorkspaceDependencyNames(headPackage);
	const metadataFiles = [];
	for (const file of changedFiles) {
		if (file !== "package.json" && !PACKAGE_MANIFEST_PATTERN.test(file)) {
			continue;
		}
		const baseJson = readJsonAt(base, file);
		const headJson = readJsonAt(head, file);
		if (
			packageManifestReleaseMetadataOnlyChanged({
				allowedRootDependencyNames,
				basePackage: baseJson,
				headPackage: headJson,
				isRootPackage: file === "package.json",
			})
		) {
			metadataFiles.push(file);
		}
	}
	return metadataFiles;
}

function metadataOnlyReleaseFiles(base, head, changedFiles) {
	const metadataFiles = [];
	for (const file of changedFiles) {
		if (RELEASE_METADATA_FILES.has(file)) {
			metadataFiles.push(file);
			continue;
		}
		if (file !== "openapi.json") {
			continue;
		}
		const baseJson = readJsonAt(base, file);
		const headJson = readJsonAt(head, file);
		if (openApiInfoVersionOnlyChanged(baseJson, headJson)) {
			metadataFiles.push(file);
		}
	}
	return metadataFiles;
}

function handledOutsideNxFiles(changedFiles) {
	return changedFiles.filter(isHandledOutsideNx);
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

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const changedFiles = git(["diff", "--name-only", args.base, args.head])
		.split("\n")
		.filter(Boolean);
	const headPackage = readPackageAt(args.head);
	const packageJsonMetadataOnlyFiles = await metadataOnlyPackageFiles(
		args.base,
		args.head,
		changedFiles,
		headPackage,
	);
	if (args.runtimePackageValidators) {
		const required = runtimePackageValidatorsRequired({
			basePackage: readPackageAt(args.base),
			changedFiles,
			headPackage,
			packageJsonMetadataOnlyFiles,
		});
		process.stdout.write(required ? "required\n" : "skipped\n");
		return;
	}
	const plan = planNxTestCommand({
		basePackage: readPackageAt(args.base),
		changedFiles,
		handledOutsideNxFiles: handledOutsideNxFiles(changedFiles),
		headPackage,
		packageJsonMetadataOnlyFiles,
		releaseMetadataOnlyFiles: metadataOnlyReleaseFiles(
			args.base,
			args.head,
			changedFiles,
		),
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
		await main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
