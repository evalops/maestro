/**
 * Package Source Resolution
 *
 * Resolves package sources from various formats:
 * - local:./path or ./path (filesystem)
 * - git:github.com/user/repo@ref (git repository)
 * - npm:@scope/name@version (npm registry)
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
// Allow the punctuation that git itself permits in branch/tag refs (see
// git-check-ref-format) such as "%", ",", and "=". Revision expressions that
// git checkout accepts, like "~" and "^", are also allowed. Shell
// metacharacters are still excluded as defense-in-depth even though refs are
// passed via execFile (no shell), and a leading "-" is rejected separately to
// prevent option injection.
const SAFE_GIT_REF_PATTERN = /^[\w./+%,=~^-]+$/;
const GIT_SAFE_CLONE_CONFIG = [
	"-c",
	"protocol.ext.allow=never",
	"-c",
	"protocol.file.allow=user",
] as const;

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

	// "git:" is Maestro's package prefix, but "git://" is the native git
	// transport scheme and must not have its scheme stripped as if it were the
	// prefix.
	if (sourceSpec.startsWith("git:") && !sourceSpec.startsWith("git://")) {
		const gitSpec = sourceSpec.slice(4); // Remove "git:" prefix
		const { url, ref } = parseGitSourceSpec(gitSpec);
		if (!url) {
			throw new Error(`Invalid package source format: ${sourceSpec}`);
		}
		validateGitRef(ref, sourceSpec);
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
		sourceSpec.startsWith("git://") ||
		sourceSpec.includes("github.com/") ||
		sourceSpec.includes("gitlab.com/") ||
		sourceSpec.includes("bitbucket.org/") ||
		(sourceSpec.endsWith(".git") && !sourceSpec.startsWith("@"))
	) {
		const { url, ref } = parseGitSourceSpec(sourceSpec);
		if (!url) {
			throw new Error(`Invalid package source format: ${sourceSpec}`);
		}
		validateGitRef(ref, sourceSpec);
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
	validateGitRef(source.ref, formatPackageSource(source));
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
					...GIT_SAFE_CLONE_CONFIG,
					"clone",
					"--depth",
					"1",
					"--branch",
					source.ref,
					cloneTarget,
					cachePath,
				]);
			} catch {
				runSyncCommand("git", [
					...GIT_SAFE_CLONE_CONFIG,
					"clone",
					cloneTarget,
					cachePath,
				]);
				runSyncCommand("git", ["-C", cachePath, "checkout", "-f", source.ref]);
			}
		} else {
			runSyncCommand("git", [
				...GIT_SAFE_CLONE_CONFIG,
				"clone",
				"--depth",
				"1",
				cloneTarget,
				cachePath,
			]);
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
 * Resolve npm package source
 */
function resolveNpmSource(source: NpmSource, cacheDir?: string): string {
	const cachePath = getCachedSourcePath(
		"npm",
		`${source.name}@${source.version ?? ""}`,
		cacheDir,
	);
	const cachedPackagePath = detectInstalledNpmPackagePath(cachePath, source);
	if (cachedPackagePath) {
		return cachedPackagePath;
	}

	rmSync(cachePath, { recursive: true, force: true });
	mkdirSync(getPackageCacheDir(cacheDir), { recursive: true });
	mkdirSync(cachePath, { recursive: true });

	const installSpec = source.version
		? `${source.name}@${source.version}`
		: source.name;

	try {
		runSyncCommand("npm", [
			"install",
			"--prefix",
			cachePath,
			"--no-save",
			"--ignore-scripts",
			"--no-package-lock",
			"--no-audit",
			"--no-fund",
			"--install-links=false",
			"--silent",
			installSpec,
		]);
	} catch (error) {
		rmSync(cachePath, { recursive: true, force: true });
		throw error;
	}

	const resolvedPackagePath = detectInstalledNpmPackagePath(cachePath, source);
	if (!resolvedPackagePath) {
		rmSync(cachePath, { recursive: true, force: true });
		throw new Error(
			`npm install succeeded but did not materialize a package for ${installSpec}`,
		);
	}

	logger.info("Resolved npm package source", {
		name: source.name,
		version: source.version,
		path: resolvedPackagePath,
	});
	return resolvedPackagePath;
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

export function normalizeGitCloneUrl(url: string): string {
	// Reject remote-helper transports like ext::command or 9p::payload without
	// blocking IPv6 literals in standard URLs such as
	// ssh://git@[2001:db8::1]/repo.git, or local paths with a slash before "::".
	const remoteHelperSeparatorIndex = url.indexOf("::");
	const firstSlashIndex = url.search(/[\\/]/);
	const remoteHelperTransport =
		remoteHelperSeparatorIndex >= 0
			? url.slice(0, remoteHelperSeparatorIndex)
			: "";
	if (
		remoteHelperSeparatorIndex !== -1 &&
		(firstSlashIndex === -1 || remoteHelperSeparatorIndex < firstSlashIndex) &&
		/^[a-z0-9][a-z0-9+._-]*$/i.test(remoteHelperTransport)
	) {
		throw new Error(`Unsupported git package source URL: ${url}`);
	}

	if (
		url.startsWith("git@") ||
		url.startsWith("/") ||
		/^[a-z]:[\\/]/i.test(url) ||
		url.startsWith("\\\\") ||
		url.startsWith("./") ||
		url.startsWith("../")
	) {
		return url;
	}

	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
		const protocol = new URL(url).protocol;
		const normalizedProtocol = protocol.startsWith("git+")
			? protocol.slice(4)
			: protocol;
		if (
			normalizedProtocol === "git:" ||
			normalizedProtocol === "http:" ||
			normalizedProtocol === "https:" ||
			normalizedProtocol === "ssh:"
		) {
			return protocol.startsWith("git+") ? url.replace(/^git\+/i, "") : url;
		}
		throw new Error(
			`Unsupported git package source URL scheme: ${protocol.replace(":", "")}`,
		);
	}

	// Known shorthand "host/path" forms (no scheme, no scp ":") are promoted to https.
	// A ":" before the first "/" means git treats it as an scp-style SSH remote
	// (e.g. "host:port/path" is host "host", path "port/path"), so those are left
	// untouched and handled by the scp branch below.
	if (
		url.startsWith("github.com/") ||
		url.startsWith("gitlab.com/") ||
		url.startsWith("bitbucket.org/")
	) {
		return `https://${url}`;
	}

	const firstColonIndex = url.indexOf(":");
	if (
		firstColonIndex !== -1 &&
		firstSlashIndex !== -1 &&
		firstSlashIndex < firstColonIndex
	) {
		return url;
	}

	if (
		/^(?:[^@/:]+@)?github\.com:.+/.test(url) ||
		/^(?:[^@/:]+@)?gitlab\.com:.+/.test(url) ||
		/^(?:[^@/:]+@)?bitbucket\.org:.+/.test(url) ||
		/^(?:[^@/:]+@)?[a-z0-9][a-z0-9._-]*:.+/i.test(url) ||
		/^(?:[^@/:]+@)?(?:localhost|[a-z0-9][a-z0-9.-]*\.[a-z0-9-]+):.+/i.test(url)
	) {
		return url;
	}

	// Relative local repositories (e.g. "repo.git" or "sub/repo.git") have no
	// scheme and no scp ":" separator. git clone accepts them as local paths
	// resolved against the working directory, so pass them through unchanged.
	if (!url.includes(":")) {
		return url;
	}

	throw new Error(`Unsupported git package source URL: ${url}`);
}

function parseGitSourceSpec(gitSpec: string): {
	url: string;
	ref: string | undefined;
} {
	const atIndex = gitSpec.lastIndexOf("@");
	const firstAtIndex = gitSpec.indexOf("@");
	const schemeSeparatorIndex = gitSpec.indexOf("://");
	const firstSlashAfterAuthority =
		schemeSeparatorIndex >= 0
			? gitSpec.indexOf("/", schemeSeparatorIndex + 3)
			: -1;
	const scpSeparatorIndex =
		schemeSeparatorIndex === -1 && !/^[a-z]:[\\/]/i.test(gitSpec)
			? gitSpec.indexOf(":")
			: -1;
	const hasUrlUserInfoSeparator =
		schemeSeparatorIndex >= 0 &&
		(firstSlashAfterAuthority === -1 || atIndex < firstSlashAfterAuthority);
	const hasScpUserHostSeparator =
		scpSeparatorIndex > 0 &&
		firstAtIndex === atIndex &&
		atIndex < scpSeparatorIndex &&
		/^(?:[^@/:]+@)?[^@/:]+:.+/.test(gitSpec);
	if (atIndex <= 0 || hasUrlUserInfoSeparator || hasScpUserHostSeparator) {
		return { url: gitSpec, ref: undefined };
	}

	return {
		url: gitSpec.slice(0, atIndex),
		ref: gitSpec.slice(atIndex + 1),
	};
}

function validateGitRef(ref: string | undefined, sourceSpec: string): void {
	if (!ref) {
		return;
	}
	if (ref.startsWith("-") || !SAFE_GIT_REF_PATTERN.test(ref)) {
		throw new Error(`Invalid git package ref in source: ${sourceSpec}`);
	}
}

function looksLikeRegistryPackageName(value: string): boolean {
	return /^(?:@[^/]+\/)?[^/]+$/.test(value);
}

function getNodeModulesPackagePath(
	cachePath: string,
	packageName: string,
): string {
	return join(cachePath, "node_modules", ...packageName.split("/"));
}

function detectInstalledNpmPackageName(
	cachePath: string,
	source: NpmSource,
): string | null {
	if (looksLikeRegistryPackageName(source.name)) {
		const directPath = getNodeModulesPackagePath(cachePath, source.name);
		if (existsSync(directPath)) {
			return source.name;
		}
	}

	try {
		const output = runSyncCommand("npm", [
			"ls",
			"--prefix",
			cachePath,
			"--json",
			"--depth=0",
		]);
		const parsed = JSON.parse(output) as {
			dependencies?: Record<string, unknown>;
		};
		const packageName = Object.keys(parsed.dependencies ?? {})[0];
		return packageName ?? null;
	} catch {
		return null;
	}
}

function detectInstalledNpmPackagePath(
	cachePath: string,
	source: NpmSource,
): string | null {
	const packageName = detectInstalledNpmPackageName(cachePath, source);
	if (!packageName) {
		return null;
	}

	const packagePath = getNodeModulesPackagePath(cachePath, packageName);
	return existsSync(packagePath) ? packagePath : null;
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
