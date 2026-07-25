#!/usr/bin/env node

import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const DEFAULT_EXCLUDES = [
	".git/**",
	"node_modules/**",
	"**/node_modules/**",
	"dist/**",
	"**/dist/**",
	"target/**",
	"**/target/**",
	"coverage/**",
	"tmp/**",
	".env",
	".env.*",
	".maestro/**",
	".cursor/**",
	".nx/**",
	".husky/_/**",
	"*.tsbuildinfo",
	"**/*.tsbuildinfo",
	"CLAUDE.md",
	".github/workflows/**",
	".github/workflows/public-release-mirror.yml",
	".github/workflows/sync-public-release-mirror.yml",
	".github/release-mirror-manifest.json",
	".github/public-release-mirror.exclude",
	"docs/release-ops.md",
	"docs/internal/**",
	"evals/internal/**",
	"scripts/internal/**",
	"test/internal/**",
	"scripts/configure-npm-trusted-publisher.mjs",
	"scripts/deprecate-release.js",
	"scripts/published-replay-evidence-gate.js",
	"scripts/release-observability-query-contract.js",
	"scripts/smoke-published-replay-e2e.js",
	"scripts/smoke-registry-install.js",
	"scripts/verify-published-replay-evidence.js",
	"scripts/validate-public-package-deps.js",
	"test/scripts/validate-public-package-deps.test.ts",
];

const PUBLIC_INCLUDE_OVERRIDES = new Set([
	".env.example",
	"packages/web/dist",
]);

const STALE_PUBLIC_TARGET_DELETES = [
	".github/release-mirror-manifest.json",
];

function parseArgs(argv) {
	const args = {
		check: false,
		excludeFile: ".github/public-release-mirror.exclude",
		packageName: "",
		report: "",
		source: process.cwd(),
		target: "",
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--check":
				args.check = true;
				break;
			case "--exclude-file":
				args.excludeFile = argv[++index] ?? args.excludeFile;
				break;
			case "--package-name":
				args.packageName = argv[++index] ?? args.packageName;
				break;
			case "--report":
				args.report = argv[++index] ?? args.report;
				break;
			case "--source":
				args.source = argv[++index] ?? args.source;
				break;
			case "--target":
				args.target = argv[++index] ?? args.target;
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (!args.target) {
		throw new Error("Missing required --target <path>");
	}

	return args;
}

function normalizePath(path) {
	return path.split(sep).join("/");
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function patternToRegExp(pattern) {
	let source = "";
	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index];
		const next = pattern[index + 1];
		if (char === "*" && next === "*") {
			source += ".*";
			index += 1;
			continue;
		}
		if (char === "*") {
			source += "[^/]*";
			continue;
		}
		source += escapeRegExp(char);
	}
	return new RegExp(`^${source}$`);
}

function readExcludePatterns(sourceRoot, excludeFile) {
	const patterns = [...DEFAULT_EXCLUDES];
	const path = resolve(sourceRoot, excludeFile);
	if (!existsSync(path)) {
		return patterns;
	}

	const configured = readFileSync(path, "utf8")
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"));
	return [...patterns, ...configured];
}

function getNestedTargetExclude(sourceRoot, targetRoot) {
	const targetWithinSource = normalizePath(relative(sourceRoot, targetRoot));
	if (
		!targetWithinSource ||
		targetWithinSource === "." ||
		targetWithinSource.startsWith("../")
	) {
		return null;
	}
	return `${targetWithinSource}/**`;
}

function createMatcher(patterns) {
	const normalizedPatterns = patterns.map((pattern) =>
		normalizePath(pattern).replace(/^\.?\//u, ""),
	);
	const regexps = normalizedPatterns
		.filter((pattern) => pattern.includes("*"))
		.map(patternToRegExp);
	const exact = new Set(
		normalizedPatterns.filter((pattern) => !pattern.includes("*")),
	);
	const prefixes = normalizedPatterns
		.flatMap((pattern) => {
			if (pattern.endsWith("/**")) {
				return [pattern.slice(0, -3)];
			}
			if (!pattern.includes("*") && pattern.endsWith("/")) {
				return [pattern.replace(/\/+$/u, "")];
			}
			return [];
		});

	return (relativePath) => {
		const normalized = normalizePath(relativePath).replace(/^\.?\//u, "");
		if (!normalized) return false;
		if (exact.has(normalized)) return true;
		if (
			[...PUBLIC_INCLUDE_OVERRIDES].some(
				(overridePath) =>
					normalized === overridePath ||
					normalized.startsWith(`${overridePath}/`),
			)
		) {
			return false;
		}
		if (
			prefixes.some(
				(prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
			)
		) {
			return true;
		}
		return regexps.some((regexp) => regexp.test(normalized));
	};
}

function hasPublicIncludeOverrideDescendant(relativePath) {
	const normalized = normalizePath(relativePath).replace(/^\.?\//u, "");
	if (!normalized) return false;
	return [...PUBLIC_INCLUDE_OVERRIDES].some((overridePath) =>
		overridePath.startsWith(`${normalized}/`),
	);
}

function walkFiles(root, shouldExclude) {
	const files = [];

	function visit(dir) {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const absolute = join(dir, entry.name);
			const relativePath = normalizePath(relative(root, absolute));
			if (shouldExclude(relativePath)) {
				if (!entry.isDirectory() || !hasPublicIncludeOverrideDescendant(relativePath)) {
					continue;
				}
			}
			if (entry.isDirectory()) {
				visit(absolute);
			} else if (entry.isFile() || entry.isSymbolicLink()) {
				files.push(relativePath);
			}
		}
	}

	visit(root);
	return files.sort();
}

function resolvePublicPackageJson(
	sourceRoot,
	packageName,
) {
	const packagePath = resolve(sourceRoot, "package.json");
	if (!existsSync(packagePath)) {
		throw new Error(`Source package.json not found: ${packagePath}`);
	}

	const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
	if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) {
		throw new Error("Source package.json must contain a JSON object");
	}

	const publicPackageName =
		packageName ||
		(pkg.maestro &&
		typeof pkg.maestro === "object" &&
		!Array.isArray(pkg.maestro) &&
		typeof pkg.maestro.canonicalPackageName === "string"
			? pkg.maestro.canonicalPackageName
			: pkg.name);

	if (typeof publicPackageName !== "string" || !publicPackageName.trim()) {
		throw new Error(
			"Could not resolve public package name; pass --package-name or set package.json maestro.canonicalPackageName",
		);
	}

	pkg.name = publicPackageName;
	pkg.maestro =
		pkg.maestro && typeof pkg.maestro === "object" && !Array.isArray(pkg.maestro)
			? pkg.maestro
			: {};
	pkg.maestro.canonicalPackageName = publicPackageName;
	pkg.maestro.packageAliases = Array.from(
		new Set(
			[
				publicPackageName,
				...(Array.isArray(pkg.maestro.packageAliases)
					? pkg.maestro.packageAliases
					: []),
			].filter((value) => typeof value === "string" && value.trim()),
		),
	);
	pkg.scripts =
		pkg.scripts && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts)
			? pkg.scripts
			: {};
	pkg.scripts["release:verify:published"] =
		"node scripts/smoke-registry-install.js";
	pkg.scripts["release:verify:published:e2e"] =
		"node scripts/smoke-published-replay-e2e.js";
	pkg.scripts["release:verify:published:evidence"] =
		"node scripts/verify-published-replay-evidence.js";
	pkg.scripts["release:deprecate"] = "node scripts/deprecate-release.js";

	return {
		content: `${JSON.stringify(pkg, null, 2)}\n`,
		publicPackageName,
	};
}

function buildMirrorPlan(sourceRoot, targetRoot, shouldExclude, packageName) {
	const sourceFiles = new Set(walkFiles(sourceRoot, shouldExclude));
	const targetFiles = new Set(walkFiles(targetRoot, shouldExclude));
	const { content: packageJsonContent, publicPackageName } =
		resolvePublicPackageJson(sourceRoot, packageName);
	const copiedPaths = [];
	const deletedPaths = [];

	for (const relativePath of [...sourceFiles].sort()) {
		const sourceContent =
			relativePath === "package.json"
				? Buffer.from(packageJsonContent, "utf8")
				: readFileSync(resolve(sourceRoot, relativePath));
		const targetPath = resolve(targetRoot, relativePath);
		const targetContent = existsSync(targetPath) ? readFileSync(targetPath) : null;
		if (!targetContent || !sourceContent.equals(targetContent)) {
			copiedPaths.push(relativePath);
		}
	}

	for (const relativePath of [...targetFiles].sort()) {
		if (sourceFiles.has(relativePath)) {
			continue;
		}
		deletedPaths.push(relativePath);
	}

	for (const relativePath of STALE_PUBLIC_TARGET_DELETES) {
		const targetPath = resolve(targetRoot, relativePath);
		if (existsSync(targetPath) && !deletedPaths.includes(relativePath)) {
			deletedPaths.push(relativePath);
		}
	}

	return {
		copiedCount: copiedPaths.length,
		copiedPaths,
		deletedCount: deletedPaths.length,
		deletedPaths,
		packageJsonContent,
		publicPackageName,
		sourceFileCount: sourceFiles.size,
		targetFileCount: targetFiles.size,
	};
}

function applyMirrorPlan(sourceRoot, targetRoot, plan) {
	for (const relativePath of plan.copiedPaths) {
		const sourcePath = resolve(sourceRoot, relativePath);
		const targetPath = resolve(targetRoot, relativePath);
		mkdirSync(dirname(targetPath), { recursive: true });
		if (relativePath === "package.json") {
			writeFileSync(targetPath, plan.packageJsonContent);
		} else {
			copyFileSync(sourcePath, targetPath);
		}
		const mode = lstatSync(sourcePath).mode & 0o777;
		chmodSync(targetPath, mode);
	}

	for (const relativePath of plan.deletedPaths) {
		rmSync(resolve(targetRoot, relativePath), { force: true });
	}

	// File deletes leave empty parent directories (e.g. packages/tui/, src/cli-tui/).
	// Prune empty dirs bottom-up so the public tree does not retain hollow shells.
	const dirs = new Set();
	for (const relativePath of plan.deletedPaths) {
		let dir = dirname(resolve(targetRoot, relativePath));
		const rootResolved = resolve(targetRoot);
		while (dir.startsWith(rootResolved) && dir !== rootResolved) {
			dirs.add(dir);
			dir = dirname(dir);
		}
	}
	for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
		try {
			if (existsSync(dir) && readdirSync(dir).length === 0) {
				rmSync(dir, { force: true });
			}
		} catch {
			// ignore races / non-empty
		}
	}
}

function writeReport(path, report) {
	if (!path) {
		return;
	}
	writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

const options = parseArgs(process.argv.slice(2));
const sourceRoot = resolve(options.source);
const targetRoot = resolve(options.target);

if (!existsSync(sourceRoot)) {
	throw new Error(`Source directory does not exist: ${sourceRoot}`);
}
if (!existsSync(targetRoot)) {
	throw new Error(`Target directory does not exist: ${targetRoot}`);
}

const excludePatterns = readExcludePatterns(sourceRoot, options.excludeFile);
const nestedTargetExclude = getNestedTargetExclude(sourceRoot, targetRoot);
if (nestedTargetExclude) {
	excludePatterns.push(nestedTargetExclude);
}

const shouldExclude = createMatcher(excludePatterns);
const plan = buildMirrorPlan(
	sourceRoot,
	targetRoot,
	shouldExclude,
	options.packageName,
);
const report = {
	copiedCount: plan.copiedCount,
	copiedPaths: plan.copiedPaths,
	deletedCount: plan.deletedCount,
	deletedPaths: plan.deletedPaths,
	publicPackageName: plan.publicPackageName,
	sourceFileCount: plan.sourceFileCount,
	targetFileCount: plan.targetFileCount,
};
writeReport(options.report, report);

if (options.check) {
	if (plan.copiedCount > 0 || plan.deletedCount > 0) {
		console.error(
			`Public release mirror drift detected for ${plan.publicPackageName}: ` +
				`${plan.copiedCount} file(s) to copy/update, ` +
				`${plan.deletedCount} stale file(s) to delete.`,
		);
		process.exit(1);
	}
	console.log(`Public release mirror is in sync for ${plan.publicPackageName}.`);
	process.exit(0);
}

applyMirrorPlan(sourceRoot, targetRoot, plan);

console.log(
	`Prepared public release mirror for ${plan.publicPackageName}: copied ${plan.copiedCount} files, deleted ${plan.deletedCount} stale files.`,
);
