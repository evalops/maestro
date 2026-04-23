/**
 * Path validation utilities for secure file operations.
 * Prevents path traversal attacks and validates file paths.
 */

import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, normalize, resolve, sep } from "node:path";
import { ERRORS, LIMITS } from "../config/constants.js";
import { createLogger } from "./logger.js";
import { expandTildePathWithHomeDir, getHomeDir } from "./path-expansion.js";

const logger = createLogger("path-validation");

/**
 * Error thrown when path validation fails
 */
export class PathValidationError extends Error {
	constructor(
		message: string,
		public readonly path: string,
		public readonly reason: string,
	) {
		super(message);
		this.name = "PathValidationError";
	}
}

/**
 * Expand ~ to home directory
 */
export function expandUserPath(path: string): string {
	return expandTildePathWithHomeDir(path, getHomeDir());
}

/**
 * Normalize and resolve path to absolute form
 */
export function normalizePath(path: string): string {
	const expanded = expandUserPath(path);
	const normalized = normalize(expanded);
	return isAbsolute(normalized)
		? normalized
		: resolve(process.cwd(), normalized);
}

/**
 * Check if path attempts to escape a base directory
 */
export function isPathTraversal(path: string, baseDir?: string): boolean {
	const normalizedPath = normalizePath(path);
	const base = baseDir ? normalizePath(baseDir) : process.cwd();

	// Check if the normalized path starts with the base directory
	const isWindows = process.platform === "win32";
	const normalizedPathCheck = isWindows
		? normalizedPath.toLowerCase()
		: normalizedPath;
	const baseCheck = isWindows ? base.toLowerCase() : base;

	return (
		!normalizedPathCheck.startsWith(baseCheck + sep) &&
		normalizedPathCheck !== baseCheck
	);
}

/**
 * Validate that a path is safe and accessible
 */
export interface PathValidationOptions {
	/** Require the path to exist */
	mustExist?: boolean;
	/** Require the path to be readable */
	mustBeReadable?: boolean;
	/** Require the path to be writable */
	mustBeWritable?: boolean;
	/** Base directory to restrict access to */
	baseDir?: string;
	/** Maximum file size in bytes */
	maxSize?: number;
	/** Allowed file extensions */
	allowedExtensions?: Set<string>;
	/** Disallow symlinks */
	noSymlinks?: boolean;
}

/**
 * Comprehensive path validation
 */
export async function validatePath(
	path: string,
	options: PathValidationOptions = {},
): Promise<string> {
	const {
		mustExist = false,
		mustBeReadable = false,
		mustBeWritable = false,
		baseDir,
		maxSize,
		allowedExtensions,
		noSymlinks = false,
	} = options;

	// Normalize the path
	let normalizedPath: string;
	try {
		normalizedPath = normalizePath(path);
	} catch (error) {
		logger.warn("Path normalization failed", { path, error });
		throw new PathValidationError(
			`Invalid path: ${path}`,
			path,
			"normalization_failed",
		);
	}

	// Check for path traversal
	if (baseDir && isPathTraversal(normalizedPath, baseDir)) {
		logger.warn("Path traversal attempt detected", {
			path,
			normalizedPath,
			baseDir,
		});
		throw new PathValidationError(
			`Path traversal detected: ${path}`,
			path,
			"path_traversal",
		);
	}

	// Check existence if required
	if (mustExist || mustBeReadable || mustBeWritable || maxSize !== undefined) {
		try {
			await access(normalizedPath, constants.F_OK);
		} catch {
			throw new PathValidationError(
				`File not found: ${path}`,
				normalizedPath,
				"not_found",
			);
		}
	}

	// Check readability
	if (mustBeReadable) {
		try {
			await access(normalizedPath, constants.R_OK);
		} catch {
			throw new PathValidationError(
				`File not readable: ${path}`,
				normalizedPath,
				"not_readable",
			);
		}
	}

	// Check writability
	if (mustBeWritable) {
		try {
			await access(normalizedPath, constants.W_OK);
		} catch {
			throw new PathValidationError(
				`File not writable: ${path}`,
				normalizedPath,
				"not_writable",
			);
		}
	}

	// Check file size
	if (maxSize !== undefined) {
		try {
			const stats = await stat(normalizedPath);
			if (stats.size > maxSize) {
				throw new PathValidationError(
					`${ERRORS.FILE_TOO_LARGE}: ${path} (${stats.size} bytes, max: ${maxSize} bytes)`,
					normalizedPath,
					"file_too_large",
				);
			}
		} catch (error) {
			if (error instanceof PathValidationError) throw error;
			// Ignore stat errors if file doesn't exist
		}
	}

	// Check file extension from the last path segment (so dirs like .git don't affect it)
	if (allowedExtensions && allowedExtensions.size > 0) {
		const name = basename(normalizedPath);
		const lastDot = name.lastIndexOf(".");
		const ext = lastDot >= 0 ? name.slice(lastDot) : "";
		if (!allowedExtensions.has(ext)) {
			throw new PathValidationError(
				`File extension not allowed: ${ext || "(none)"}`,
				normalizedPath,
				"extension_not_allowed",
			);
		}
	}

	// Check for symlinks
	if (noSymlinks) {
		try {
			const realPath = await realpath(normalizedPath);
			if (realPath !== normalizedPath) {
				throw new PathValidationError(
					`Symlinks not allowed: ${path}`,
					normalizedPath,
					"symlink_detected",
				);
			}
		} catch (error) {
			if (error instanceof PathValidationError) throw error;
			// Ignore errors if file doesn't exist yet
		}
	}

	return normalizedPath;
}

/**
 * Synchronous path validation (basic checks only)
 */
export function validatePathSync(path: string, baseDir?: string): string {
	const normalizedPath = normalizePath(path);

	if (baseDir && isPathTraversal(normalizedPath, baseDir)) {
		throw new PathValidationError(
			`Path traversal detected: ${path}`,
			path,
			"path_traversal",
		);
	}

	return normalizedPath;
}

/**
 * Check if a path is within the current working directory
 */
export function isWithinCwd(path: string, cwd = process.cwd()): boolean {
	const normalizedPath = normalizePath(path);
	const normalizedCwd = normalizePath(cwd);
	const isWindows = process.platform === "win32";

	const pathCheck = isWindows ? normalizedPath.toLowerCase() : normalizedPath;
	const cwdCheck = isWindows ? normalizedCwd.toLowerCase() : normalizedCwd;

	return pathCheck.startsWith(cwdCheck + sep) || pathCheck === cwdCheck;
}

/**
 * Safely join paths with validation
 */
export function safejoin(base: string, ...parts: string[]): string {
	const joined = resolve(base, ...parts);
	const normalizedBase = normalizePath(base);

	const isWindows = process.platform === "win32";
	const joinedCheck = isWindows ? joined.toLowerCase() : joined;
	const baseCheck = isWindows ? normalizedBase.toLowerCase() : normalizedBase;

	if (!joinedCheck.startsWith(baseCheck + sep) && joinedCheck !== baseCheck) {
		throw new PathValidationError(
			`Path would escape base directory: ${parts.join("/")}`,
			joined,
			"path_traversal",
		);
	}

	return joined;
}

/**
 * Validate multiple paths in parallel
 */
export async function validatePaths(
	paths: string[],
	options: PathValidationOptions = {},
): Promise<string[]> {
	return Promise.all(paths.map((path) => validatePath(path, options)));
}
