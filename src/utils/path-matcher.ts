/**
 * Path Pattern Matching Utilities
 *
 * Provides secure path matching with glob patterns, symlink resolution,
 * and home directory expansion. Used for policy enforcement and access control.
 *
 * ## Security Features
 *
 * - Symlink resolution prevents bypass attacks via symbolic links
 * - Both original and resolved paths are checked for defense in depth
 * - matchBase is disabled to prevent patterns from matching anywhere
 * - Home directory expansion supports ~ notation
 *
 * ## Pattern Syntax
 *
 * | Pattern             | Matches                              |
 * |---------------------|--------------------------------------|
 * | `*`                 | Any single segment                   |
 * | `**`                | Any number of segments               |
 * | `*.md`              | Any file ending in .md               |
 * | `src/**\/*.ts`      | Any .ts file under src/              |
 *
 * @module utils/path-matcher
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { minimatch } from "minimatch";

/**
 * Expand ~ to user's home directory.
 *
 * Handles both standalone ~ and ~/path patterns.
 *
 * @example
 * expandHomeDir("~") // "/home/user"
 * expandHomeDir("~/projects") // "/home/user/projects"
 * expandHomeDir("/absolute/path") // "/absolute/path" (unchanged)
 *
 * @param filePath - Path that may contain ~ prefix
 * @returns Expanded path with ~ replaced by home directory
 */
export function expandHomeDir(filePath: string): string {
	if (filePath === "~" || filePath.startsWith("~/")) {
		return join(homedir(), filePath.slice(1));
	}
	return filePath;
}

/**
 * Resolve a path to its real location, following symlinks.
 *
 * Returns the resolved path, or falls back to the original if resolution fails.
 * For non-existent paths, attempts to resolve the parent directory.
 *
 * @example
 * // For existing file with symlink
 * resolveRealPath("/home/user/link-to-file") // "/home/user/real-file"
 *
 * // For non-existent file in existing directory
 * resolveRealPath("/home/user/new-file") // "/home/user/new-file"
 *
 * @param filePath - Path to resolve (may contain ~ or symlinks)
 * @returns Fully resolved path with symlinks followed
 */
export function resolveRealPath(filePath: string): string {
	try {
		const expanded = expandHomeDir(filePath);
		const resolved = resolve(expanded);
		// Check if path exists and resolve symlinks
		if (existsSync(resolved)) {
			return realpathSync(resolved);
		}
		// For non-existent paths, resolve parent directory symlinks if possible
		const parentDir = resolve(expanded, "..");
		if (existsSync(parentDir)) {
			const realParent = realpathSync(parentDir);
			const basename = resolve(expanded).split("/").pop() || "";
			return join(realParent, basename);
		}
		return resolved;
	} catch {
		return resolve(expandHomeDir(filePath));
	}
}

/**
 * Check if a path matches any pattern in a list using glob syntax.
 *
 * ## Security Features
 *
 * - matchBase is disabled to prevent patterns like "*.txt" from matching anywhere
 * - Symlinks are resolved to prevent bypasses via symbolic links
 * - Both original and resolved paths are checked for defense in depth
 *
 * ## Pattern Matching Rules
 *
 * - Glob patterns (with *, ?, [, {) are matched as-is
 * - Non-glob patterns are resolved to absolute paths
 * - Directory patterns match any file within that directory hierarchy
 *
 * @example
 * // Glob pattern matching
 * matchesPathPattern("/home/user/file.txt", ["*.txt"]) // false (matchBase disabled)
 * matchesPathPattern("/home/user/file.txt", ["/home/user/*.txt"]) // true
 *
 * // Directory matching
 * matchesPathPattern("/home/user/file.txt", ["/home/user"]) // true
 * matchesPathPattern("/home/user/sub/file.txt", ["/home/user"]) // true
 *
 * // Symlink handling
 * // If /link -> /real, both paths are checked
 * matchesPathPattern("/link/file.txt", ["/real/**"]) // true
 *
 * @param filePath - Path to check against patterns
 * @param patterns - Array of glob patterns or directory paths
 * @returns true if path matches any pattern
 */
export function matchesPathPattern(
	filePath: string,
	patterns: string[],
): boolean {
	const expandedPath = expandHomeDir(filePath);
	const normalizedPath = resolve(expandedPath);
	// Also check the real path (symlinks resolved) for security
	const realPath = resolveRealPath(filePath);

	for (const pattern of patterns) {
		// Resolve pattern to absolute path for consistent matching, unless it's a glob
		const expandedPattern = expandHomeDir(pattern);
		// If pattern contains glob characters, do not resolve (avoids pinning to CWD)
		// If pattern is relative and NOT a glob, resolve it to absolute CWD-based path
		const isGlob = /[*?{\[]/.test(expandedPattern);
		const resolvedPattern = isGlob ? expandedPattern : resolve(expandedPattern);

		// Check both the original path and the symlink-resolved path
		for (const pathToCheck of [normalizedPath, realPath]) {
			// Use minimatch for glob patterns (**, *, ?)
			// IMPORTANT: matchBase: false ensures patterns must match from root
			if (minimatch(pathToCheck, resolvedPattern, { dot: true })) {
				return true;
			}

			// For directory patterns without globs, check proper hierarchy (with separator)
			// This handles cases like "/home/user" matching "/home/user/file.txt"
			if (
				!pattern.includes("*") &&
				!pattern.includes("?") &&
				(pathToCheck === resolvedPattern ||
					pathToCheck.startsWith(`${resolvedPattern}/`))
			) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Check if a model ID matches any pattern (supports wildcards).
 *
 * Uses minimatch for safe, consistent glob matching (avoids ReDoS).
 * Case-insensitive matching is used for model IDs.
 *
 * @example
 * matchesModelPattern("anthropic/claude-3", ["anthropic/*"]) // true
 * matchesModelPattern("openai/gpt-4", ["anthropic/*"]) // false
 * matchesModelPattern("GPT-4", ["gpt-*"]) // true (case-insensitive)
 *
 * @param modelId - The model identifier to check
 * @param patterns - Array of glob patterns to match against
 * @returns true if model ID matches any pattern
 */
export function matchesModelPattern(
	modelId: string,
	patterns: string[],
): boolean {
	for (const pattern of patterns) {
		if (minimatch(modelId, pattern, { nocase: true, dot: true })) {
			return true;
		}
	}
	return false;
}
