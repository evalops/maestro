/**
 * Package Source Resolution
 *
 * Resolves package sources from various formats:
 * - local:./path or ./path (filesystem)
 * - git:github.com/user/repo@ref (git repository)
 * - npm:@scope/name@version (npm registry - future)
 */

import { isAbsolute, join, resolve } from "node:path";
import { createLogger } from "../utils/logger.js";
import type {
	GitSource,
	LocalSource,
	NpmSource,
	PackageSource,
} from "./types.js";

const logger = createLogger("packages:sources");

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
	switch (source.type) {
		case "local":
			return resolveLocalSource(source);
		case "git":
			return resolveGitSource(source, cacheDir);
		case "npm":
			return resolveNpmSource(source, cacheDir);
	}
}

/**
 * Resolve local filesystem source
 */
function resolveLocalSource(source: LocalSource): string {
	return source.path;
}

/**
 * Resolve git repository source (future implementation)
 */
async function resolveGitSource(
	source: GitSource,
	_cacheDir?: string,
): Promise<string> {
	// TODO: Implement git cloning
	// 1. Generate cache key from URL + ref
	// 2. Check if already cloned in cache
	// 3. If not, clone to cache directory
	// 4. If ref specified, checkout ref
	// 5. Return path to cloned directory

	logger.warn("Git source resolution not yet implemented", { source });
	throw new Error(
		`Git source resolution not yet implemented: ${source.url}${source.ref ? `@${source.ref}` : ""}`,
	);
}

/**
 * Resolve npm package source (future implementation)
 */
async function resolveNpmSource(
	source: NpmSource,
	_cacheDir?: string,
): Promise<string> {
	// TODO: Implement npm package resolution
	// 1. Generate cache key from name + version
	// 2. Check if already installed in cache
	// 3. If not, npm install to cache directory
	// 4. Return path to installed package

	logger.warn("npm source resolution not yet implemented", { source });
	throw new Error(
		`npm source resolution not yet implemented: ${source.name}${source.version ? `@${source.version}` : ""}`,
	);
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
