/**
 * Filesystem Utilities - Shared helpers for directory and file operations
 *
 * Provides consistent error handling and reduces code duplication
 * across modules that need to ensure directories exist.
 */

import { existsSync, mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";

/**
 * Ensure a directory exists, creating it (and parents) if necessary.
 * Synchronous version - use in constructors or init code.
 *
 * @param dirPath - Directory path to ensure exists
 * @returns true if directory was created, false if it already existed
 */
export function ensureDirSync(dirPath: string): boolean {
	if (existsSync(dirPath)) {
		return false;
	}
	mkdirSync(dirPath, { recursive: true });
	return true;
}

/**
 * Ensure a directory exists, creating it (and parents) if necessary.
 * Async version - use in async functions.
 *
 * @param dirPath - Directory path to ensure exists
 * @returns true if directory was created, false if it already existed
 */
export async function ensureDir(dirPath: string): Promise<boolean> {
	if (existsSync(dirPath)) {
		return false;
	}
	await mkdir(dirPath, { recursive: true });
	return true;
}
