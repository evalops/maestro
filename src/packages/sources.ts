/**
 * Package Source Resolution
 *
 * Resolves package sources from various formats:
 * - local:./path or ./path (filesystem)
 * - git:github.com/user/repo@ref (git repository)
 * - npm:@scope/name@version (npm registry - future)
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { PATHS } from "../config/constants.js";
import { createLogger } from "../utils/logger.js";
import type {
	GitSource,
	LocalSource,
	NpmSource,
	PackageSource,
} from "./types.js";

const logger = createLogger("packages:sources");
const resolvedPackageSourcePaths = new Map<string, string>();

/**
 * Parse a package source string into structured format
 *
 * Supported formats:
 * - "local:./path" or "./path" → LocalSource
 * - "git:github.com/user/repo" → GitSource
 * - "git:github.com/user/repo@v1.0.0" → GitSource with ref
 * - "npm:@scope/name@1.0.0" → NpmSource
 *
 * @param sourceSpec - Source specification string
 * @param cwd - Working directory for resolving relative paths
 * @returns Parsed package source
 * @throws Error if source format is invalid
 */
export function parsePackageSource(
	sourceSpec: string,
	cwd?: string,
): PackageSource {
	const workingDir = cwd ?? process.cwd();

	// Handle explicit prefix formats
	if (sourceSpec.startsWith("local:")) {
		const path = sourceSpec.slice(6); // Remove "local:" prefix
		return {
			type: "local",
			path: isAbsolute(path) ? path : resolve(workingDir, path),
		};
	}

	if (sourceSpec.startsWith("git:")) {
		const gitSpec = sourceSpec.slice(4); // Remove "git:" prefix
		const [url, ref] = gitSpec.split("@");
		if (!url) {
			throw new Error(`Invalid package source format: ${sourceSpec}`);
		}
		return {
			type: "git",
			url,
			ref,
		};
	}

	if (sourceSpec.startsWith("npm:")) {
		const npmSpec = sourceSpec.slice(4); // Remove "npm:" prefix
		const atIndex = npmSpec.lastIndexOf("@");

		// Handle scoped packages (@scope/name@version)
		if (npmSpec.startsWith("@") && atIndex > 0) {
			return {
				type: "npm",
				name: npmSpec.slice(0, atIndex),
				version: npmSpec.slice(atIndex + 1),
			};
		}

		// Handle unscoped packages (name@version)
		if (atIndex > 0) {
			return {
				type: "npm",
				name: npmSpec.slice(0, atIndex),
				version: npmSpec.slice(atIndex + 1),
			};
		}

		// No version specified
		return {
			type: "npm",
			name: npmSpec,
		};
	}

	// Auto-detect format without prefix

	// If it looks like a filesystem path
	if (
		sourceSpec.startsWith("./") ||
		sourceSpec.startsWith("../") ||
		sourceSpec.startsWith("/")
	) {
		return {
			type: "local",
			path: isAbsolute(sourceSpec)
				? sourceSpec
				: resolve(workingDir, sourceSpec),
		};
	}

	// If it looks like a git URL
	if (
		sourceSpec.includes("github.com/") ||
		sourceSpec.includes("gitlab.com/") ||
		sourceSpec.includes("bitbucket.org/") ||
		sourceSpec.endsWith(".git")
	) {
		const [url, ref] = sourceSpec.split("@");
		if (!url) {
			throw new Error(`Invalid package source format: ${sourceSpec}`);
		}
		return {
			type: "git",
			url,
			ref,
		};
	}

	// If it looks like an npm package
	if (sourceSpec.startsWith("@") || /^[a-z0-9-]+$/i.test(sourceSpec)) {
		const atIndex = sourceSpec.lastIndexOf("@");
		if (sourceSpec.startsWith("@") && atIndex > 0) {
			return {
				type: "npm",
				name: sourceSpec.slice(0, atIndex),
				version: sourceSpec.slice(atIndex + 1),
			};
		}
		return {
			type: "npm",
			name: sourceSpec,
		};
	}

	throw new Error(`Invalid package source format: ${sourceSpec}`);
}

/**
 * Resolve a package source to an absolute filesystem path
 *
 * For local sources, this returns the path directly.
 * For git/npm sources, this would clone/install to cache directory.
 *
 * @param source - Package source to resolve
 * @param cacheDir - Cache directory for remote packages
 * @returns Absolute path to package directory
 */
export async function resolvePackageSource(
	source: PackageSource,
	cacheDir?: string,
): Promise<string> {
	return resolvePackageSourceSync(source, cacheDir);
}

export function refreshPackageSourceSync(
	source: PackageSource,
	cacheDir?: string,
): string {
	clearCachedPackageSource(source, cacheDir);
	return resolvePackageSourceSync(source, cacheDir);
}

export function resolvePackageSourceSync(
	source: PackageSource,
	cacheDir?: string,
): string {
	switch (source.type) {
		case "local":
			return resolveLocalSource(source);
		case "git":
			return resolveGitSourceSync(source, cacheDir);
		case "npm":
			return resolveNpmSource(source, cacheDir);
	}
}

export function clearResolvedPackageSourceCache(): void {
	resolvedPackageSourcePaths.clear();
}

export function clearCachedPackageSourcePath(path: string): boolean {
	const existed = existsSync(path);
	rmSync(path, { recursive: true, force: true });
	for (const [key, value] of resolvedPackageSourcePaths.entries()) {
		if (value === path) {
			resolvedPackageSourcePaths.delete(key);
		}
	}
	return existed;
}

export function clearCachedPackageSource(
	source: PackageSource,
	cacheDir?: string,
): { cleared: boolean; path: string | null } {
	const remoteIdentity = getRemoteSourceIdentity(source);
	if (!remoteIdentity) {
		return { cleared: false, path: null };
	}

	const resolvedPath = getCachedSourcePath(
		remoteIdentity.kind,
		remoteIdentity.identity,
		cacheDir,
	);
	const cacheKey = `${remoteIdentity.kind}:${remoteIdentity.identity}`;
	const exists = existsSync(resolvedPath);
	rmSync(resolvedPath, { recursive: true, force: true });
	resolvedPackageSourcePaths.delete(cacheKey);
	return {
		cleared: exists,
		path: resolvedPath,
	};
}

export function getCachedRemotePackageSourcePath(
	source: GitSource | NpmSource,
	cacheDir?: string,
): string {
	const remoteIdentity = getRemoteSourceIdentity(source)!;
	return getCachedSourcePath(
		remoteIdentity.kind,
		remoteIdentity.identity,
		cacheDir,
	);
}

export function listCachedRemotePackageSourcePaths(
	cacheDir?: string,
): string[] {
	const root = getPackageCacheDir(cacheDir);
	if (!existsSync(root)) {
		return [];
	}

	return readdirSync(root, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isDirectory() &&
				(entry.name.startsWith("git-") || entry.name.startsWith("npm-")),
		)
		.map((entry) => join(root, entry.name));
}

/**
 * Resolve local filesystem source
 */
function resolveLocalSource(source: LocalSource): string {
	return source.path;
}

/**
 * Resolve git repository source
 */
function resolveGitSourceSync(source: GitSource, cacheDir?: string): string {
	const cachePath = getCachedSourcePath(
		"git",
		`${source.url}@${source.ref ?? ""}`,
		cacheDir,
	);
	if (existsSync(join(cachePath, ".git"))) {
		return cachePath;
	}

	rmSync(cachePath, { recursive: true, force: true });
	mkdirSync(getPackageCacheDir(cacheDir), { recursive: true });
	const cloneTarget = normalizeGitCloneUrl(source.url);
	try {
		if (source.ref) {
			try {
				runSyncCommand("git", [
					"clone",
					"--depth",
					"1",
					"--branch",
					source.ref,
					cloneTarget,
					cachePath,
				]);
			} catch {
				runSyncCommand("git", ["clone", cloneTarget, cachePath]);
				runSyncCommand("git", ["-C", cachePath, "checkout", "-f", source.ref]);
			}
		} else {
			runSyncCommand("git", ["clone", "--depth", "1", cloneTarget, cachePath]);
		}
	} catch (error) {
		rmSync(cachePath, { recursive: true, force: true });
		throw error;
	}

	logger.info("Resolved git package source", {
		url: source.url,
		ref: source.ref,
		path: cachePath,
	});
	return cachePath;
}

/**
 * Resolve npm package source (future implementation)
 */
function resolveNpmSource(source: NpmSource, _cacheDir?: string): string {
	logger.warn("npm source resolution not yet implemented", { source });
	throw new Error(
		`npm source resolution not yet implemented: ${source.name}${source.version ? `@${source.version}` : ""}`,
	);
}

export function getPackageCacheDir(cacheDir?: string): string {
	return cacheDir ?? PATHS.PACKAGE_CACHE_DIR;
}

function getCachedSourcePath(
	kind: "git" | "npm",
	identity: string,
	cacheDir?: string,
): string {
	const cacheKey = `${kind}:${identity}`;
	const memoized = resolvedPackageSourcePaths.get(cacheKey);
	if (memoized && existsSync(memoized)) {
		return memoized;
	}

	const digest = createHash("sha256")
		.update(cacheKey)
		.digest("hex")
		.slice(0, 16);
	const resolvedPath = join(getPackageCacheDir(cacheDir), `${kind}-${digest}`);
	resolvedPackageSourcePaths.set(cacheKey, resolvedPath);
	return resolvedPath;
}

function getRemoteSourceIdentity(
	source: PackageSource,
): { kind: "git" | "npm"; identity: string } | null {
	switch (source.type) {
		case "local":
			return null;
		case "git":
			return {
				kind: "git",
				identity: `${source.url}@${source.ref ?? ""}`,
			};
		case "npm":
			return {
				kind: "npm",
				identity: `${source.name}@${source.version ?? ""}`,
			};
	}
}

function normalizeGitCloneUrl(url: string): string {
	if (
		url.startsWith("http://") ||
		url.startsWith("https://") ||
		url.startsWith("ssh://") ||
		url.startsWith("git@") ||
		url.startsWith("/") ||
		url.startsWith("./") ||
		url.startsWith("../")
	) {
		return url;
	}

	if (
		url.startsWith("github.com/") ||
		url.startsWith("gitlab.com/") ||
		url.startsWith("bitbucket.org/")
	) {
		return `https://${url}`;
	}

	return url;
}

function runSyncCommand(command: string, args: string[]): string {
	try {
		return execFileSync(command, args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch (error) {
		const stderr =
			error instanceof Error && "stderr" in error
				? String((error as { stderr?: string | Buffer }).stderr ?? "").trim()
				: "";
		const message =
			stderr || (error instanceof Error ? error.message : String(error));
		throw new Error(`${command} ${args.join(" ")} failed: ${message}`);
	}
}

/**
 * Format a package source as a string
 */
export function formatPackageSource(source: PackageSource): string {
	switch (source.type) {
		case "local":
			return `local:${source.path}`;
		case "git":
			return `git:${source.url}${source.ref ? `@${source.ref}` : ""}`;
		case "npm":
			return `npm:${source.name}${source.version ? `@${source.version}` : ""}`;
	}
}
