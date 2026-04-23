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
	"coverage/**",
	"tmp/**",
	".env",
	".env.*",
	".maestro/**",
	".cursor/**",
	".husky/_/**",
	"AGENTS.md",
	"CLAUDE.md",
	".github/workflows/**",
	".github/workflows/public-release-mirror.yml",
	".github/workflows/sync-public-release-mirror.yml",
	".github/release-mirror-manifest.json",
	".github/public-release-mirror.exclude",
	"docs/release-ops.md",
	"docs/internal/**",
	"scripts/configure-npm-trusted-publisher.mjs",
	"scripts/deprecate-release.js",
	"scripts/smoke-registry-install.js",
	"scripts/validate-public-package-deps.js",
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
			prefixes.some(
				(prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
			)
		) {
			return true;
		}
		return regexps.some((regexp) => regexp.test(normalized));
	};
}

function walkFiles(root, shouldExclude) {
	const files = [];

	function visit(dir) {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const absolute = join(dir, entry.name);
			const relativePath = normalizePath(relative(root, absolute));
			if (shouldExclude(relativePath)) {
				continue;
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
		const sourcePath = resolve(sourceRoot, relativePath);
		const sourceContent =
			relativePath === "package.json"
				? Buffer.from(packageJsonContent, "utf8")
				: readFileSync(sourcePath);
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
