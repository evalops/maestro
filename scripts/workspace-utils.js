#!/usr/bin/env node
// @ts-check

/**
 * Shared workspace helpers for versioning scripts.
 * Plain JS for direct Node execution; typed via JSDoc for safety.
 */

import {
	existsSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {string} startDir
 */
function findRootDir(startDir) {
	let current = process.cwd();
	let attempt = startDir;
	while (true) {
		const candidate = join(attempt, "package.json");
		if (existsSync(candidate)) {
			return { rootDir: attempt, packagePath: candidate };
		}
		const parent = dirname(attempt);
		if (parent === attempt) {
			throw new Error("Could not locate package.json from current directory");
		}
		attempt = parent;
	}
}

let rootContextCache = null;
function getRootContext() {
	if (rootContextCache) return rootContextCache;
	rootContextCache = findRootDir(process.cwd());
	return rootContextCache;
}

/**
 * @param {string} path
 * @returns {Record<string, unknown>}
 */
function parseJsonFile(path) {
	try {
		const content = readFileSync(path, "utf-8");
		const parsed = JSON.parse(content);
		if (!isObject(parsed)) {
			throw new Error("Parsed value is not an object");
		}
		return parsed;
	} catch (error) {
		const reason =
			error instanceof Error ? error.message : "Unknown file read error";
		throw new Error(`Failed to read ${path}: ${reason}`);
	}
}

export function loadRootPackage() {
	const { packagePath } = getRootContext();
	if (!existsSync(packagePath)) {
		throw new Error("Root package.json not found");
	}
	return parseJsonFile(packagePath);
}

function hasWorkspaceProtocolDependency(section) {
	if (!section || typeof section !== "object") {
		return false;
	}

	return Object.values(section).some(
		(value) => typeof value === "string" && value.startsWith("workspace:"),
	);
}

function getWorkspaceGlobs(rootPackage) {
	if (!rootPackage.workspaces) {
		throw new Error("No workspaces defined in package.json");
	}
	if (Array.isArray(rootPackage.workspaces)) {
		return rootPackage.workspaces;
	}
	if (Array.isArray(rootPackage.workspaces.packages)) {
		return rootPackage.workspaces.packages;
	}
	throw new Error("Unsupported workspace configuration in package.json");
}

function escapeRegExp(value) {
	return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function globTokenPattern(value) {
	let pattern = "";
	for (const char of value) {
		pattern += char === "*" ? "[^/]*" : escapeRegExp(char);
	}
	return pattern;
}

function segmentHasPatternSyntax(segment) {
	return segment.includes("*") || /\{[^{}]+,[^{}]*\}/u.test(segment);
}

function segmentPatternToRegExp(segment) {
	let pattern = "";
	for (let index = 0; index < segment.length; index += 1) {
		const char = segment[index];
		if (char === "*") {
			pattern += "[^/]*";
			continue;
		}
		if (char === "{") {
			const end = segment.indexOf("}", index + 1);
			const body = end === -1 ? "" : segment.slice(index + 1, end);
			if (body.includes(",")) {
				pattern += `(?:${body.split(",").map(globTokenPattern).join("|")})`;
				index = end;
				continue;
			}
		}
		pattern += escapeRegExp(char);
	}
	return new RegExp(`^${pattern}$`);
}

function listDirectories(path) {
	try {
		return readdirSync(path, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(path, entry.name));
	} catch {
		return [];
	}
}

function expandWorkspacePattern(rootDir, pattern) {
	const segments = pattern.split(/[\\/]+/u).filter(Boolean);
	let directories = [rootDir];

	for (const segment of segments) {
		if (segment === "**") {
			const descendants = [...directories];
			const visit = (dir) => {
				for (const child of listDirectories(dir)) {
					descendants.push(child);
					visit(child);
				}
			};
			for (const dir of directories) {
				visit(dir);
			}
			directories = Array.from(new Set(descendants));
			continue;
		}

		if (segmentHasPatternSyntax(segment)) {
			const regexp = segmentPatternToRegExp(segment);
			directories = directories.flatMap((dir) =>
				listDirectories(dir).filter((child) =>
					regexp.test(child.split(/[\\/]/u).pop() ?? ""),
				),
			);
			continue;
		}

		directories = directories
			.map((dir) => join(dir, segment))
			.filter((dir) => existsSync(dir));
	}

	return directories
		.map((dir) => join(dir, "package.json"))
		.filter((path) => existsSync(path))
		.map((path) => resolvePath(path));
}

async function resolveWorkspacePackagePathsWithGlob(rootDir, globs) {
	try {
		const { globSync } = await import("glob");
		return globs.flatMap((pattern) =>
			globSync(join(pattern, "package.json"), {
				cwd: rootDir,
				absolute: true,
				nodir: true,
			}).map((p) => resolvePath(p)),
		);
	} catch {
		return globs.flatMap((pattern) => expandWorkspacePattern(rootDir, pattern));
	}
}

/**
 * @param {Record<string, unknown>} rootPackage
 */
export async function getWorkspacePackagePaths(rootPackage) {
	const globs = getWorkspaceGlobs(rootPackage);
	const { rootDir } = getRootContext();
	const paths = new Set(await resolveWorkspacePackagePathsWithGlob(rootDir, globs));

	if (paths.size === 0) {
		throw new Error("No workspace package.json files found");
	}

	return Array.from(paths);
}

/**
 * @param {string} path
 */
export function readPackageJson(path) {
	const pkg = parseJsonFile(path);
	if (!pkg.name || typeof pkg.name !== "string") {
		throw new Error(`Package at ${path} is missing a name`);
	}
	return pkg;
}

/**
 * @param {string} path
 * @param {Record<string, unknown>} pkg
 */
export function writePackageJson(path, pkg) {
	writeFileSync(path, `${JSON.stringify(pkg, null, "\t")}\n`);
}

/**
 * @param {Record<string, unknown>} rootPackage
 * @returns {Promise<Array<{name: string; path: string; data: Record<string, unknown>}>>}
 */
export async function getWorkspacePackages(rootPackage) {
	const packagePaths = await getWorkspacePackagePaths(rootPackage);
	return packagePaths.map((path) => {
		const data = readPackageJson(path);
		return { name: /** @type {string} */ (data.name), path, data };
	});
}

/**
 * @param {Record<string, unknown>} pkg
 * @param {string} version
 * @param {Set<string>} internalNames
 */
export function syncInternalDependencies(pkg, version, internalNames) {
	const setVersion = (section) => {
		if (!section) return;
		for (const dep of Object.keys(section)) {
			if (internalNames.has(dep)) {
				section[dep] = `^${version}`;
			}
		}
	};

	setVersion(pkg.dependencies);
	setVersion(pkg.devDependencies);
	setVersion(pkg.peerDependencies);
	setVersion(pkg.optionalDependencies);
}

export function verifyAlignedVersions(packages, expectedVersion) {
	const mismatched = packages.filter(
		(pkg) => pkg.data.version !== expectedVersion,
	);
	if (mismatched.length > 0) {
		const details = mismatched
			.map((pkg) => `${pkg.name}: ${pkg.data.version}`)
			.join(", ");
		throw new Error(
			`Version sync incomplete; mismatched packages: ${details}`,
		);
	}
}

export function getRootPackagePath() {
	return getRootContext().packagePath;
}

export function shouldManagePackageLock(rootPackage) {
	const { rootDir } = getRootContext();
	if (!existsSync(join(rootDir, "package-lock.json"))) {
		return false;
	}

	return ![
		rootPackage.dependencies,
		rootPackage.devDependencies,
		rootPackage.peerDependencies,
		rootPackage.optionalDependencies,
	].some(hasWorkspaceProtocolDependency);
}
