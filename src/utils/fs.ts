/**
 * Centralized file system utilities with consistent error handling.
 * Replaces scattered readFileSync/writeFileSync/existsSync calls.
 */

import {
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { access } from "node:fs/promises";
import { dirname } from "node:path";
import { safeJsonParse, safeJsonStringify } from "./json.js";
import { createLogger } from "./logger.js";

const logger = createLogger("fs-utils");

export class FileSystemError extends Error {
	constructor(
		message: string,
		public readonly path: string,
		public readonly operation: string,
		public readonly cause?: Error,
	) {
		super(message);
		this.name = "FileSystemError";
	}
}

/**
 * Safely check if a file exists
 */
export function fileExists(path: string): boolean {
	try {
		return existsSync(path);
	} catch (error) {
		logger.debug("File existence check failed", { path, error });
		return false;
	}
}

/**
 * Safely check if a file is readable
 */
export async function isReadable(path: string): Promise<boolean> {
	try {
		await access(path, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Safely check if a file is writable
 */
export async function isWritable(path: string): Promise<boolean> {
	try {
		await access(path, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Read text file with error handling
 */
export function readTextFile(
	path: string,
	options: { encoding?: BufferEncoding; fallback?: string } = {},
): string {
	const { encoding = "utf-8", fallback } = options;

	try {
		if (!fileExists(path)) {
			if (fallback !== undefined) {
				return fallback;
			}
			throw new FileSystemError(`File not found: ${path}`, path, "read");
		}

		return readFileSync(path, encoding);
	} catch (error) {
		if (error instanceof FileSystemError) throw error;

		const fsError = new FileSystemError(
			`Failed to read file: ${path}`,
			path,
			"read",
			error instanceof Error ? error : undefined,
		);

		if (fallback !== undefined) {
			logger.warn("File read failed, using fallback", { path, error });
			return fallback;
		}

		logger.error(
			"File read failed",
			error instanceof Error ? error : undefined,
			{ path },
		);
		throw fsError;
	}
}

/**
 * Write text file with error handling and automatic directory creation
 */
export function writeTextFile(
	path: string,
	content: string,
	options: { encoding?: BufferEncoding; createDirs?: boolean } = {},
): void {
	const { encoding = "utf-8", createDirs = true } = options;

	try {
		if (createDirs) {
			const dir = dirname(path);
			if (!fileExists(dir)) {
				mkdirSync(dir, { recursive: true });
			}
		}

		writeFileSync(path, content, encoding);
		logger.debug("File written successfully", { path, size: content.length });
	} catch (error) {
		const fsError = new FileSystemError(
			`Failed to write file: ${path}`,
			path,
			"write",
			error instanceof Error ? error : undefined,
		);
		logger.error(
			"File write failed",
			error instanceof Error ? error : undefined,
			{ path },
		);
		throw fsError;
	}
}

/**
 * Read JSON file with parsing and error handling
 */
export function readJsonFile<T = unknown>(
	path: string,
	options: { fallback?: T } = {},
): T {
	const { fallback } = options;

	try {
		const content = readTextFile(path, {
			fallback: fallback !== undefined ? "" : undefined,
		});

		if (content === "" && fallback !== undefined) {
			return fallback;
		}

		const result = safeJsonParse<T>(content, path);
		if (!result.success) {
			if (fallback !== undefined) {
				logger.warn("JSON parse failed, using fallback", {
					path,
					error: result.error.message,
				});
				return fallback;
			}
			throw result.error;
		}

		return result.data;
	} catch (error) {
		if (fallback !== undefined) {
			logger.warn("Failed to read JSON file, using fallback", { path, error });
			return fallback;
		}
		throw error;
	}
}

/**
 * Write JSON file with formatting and error handling
 */
export function writeJsonFile(
	path: string,
	data: unknown,
	options: { pretty?: boolean; createDirs?: boolean } = {},
): void {
	const { pretty = true, createDirs = true } = options;

	try {
		const content = pretty
			? JSON.stringify(data, null, 2)
			: safeJsonStringify(data);

		writeTextFile(path, content, { createDirs });
	} catch (error) {
		throw new FileSystemError(
			`Failed to write JSON file: ${path}`,
			path,
			"write-json",
			error instanceof Error ? error : undefined,
		);
	}
}

/**
 * Ensure a directory exists, creating it if necessary
 */
export function ensureDir(path: string): void {
	try {
		if (!fileExists(path)) {
			mkdirSync(path, { recursive: true });
			logger.debug("Directory created", { path });
		}
	} catch (error) {
		throw new FileSystemError(
			`Failed to create directory: ${path}`,
			path,
			"mkdir",
			error instanceof Error ? error : undefined,
		);
	}
}

/**
 * Safely append to a file
 */
export function appendTextFile(
	path: string,
	content: string,
	options: { encoding?: BufferEncoding; createDirs?: boolean } = {},
): void {
	const { encoding = "utf-8", createDirs = true } = options;

	try {
		if (createDirs) {
			ensureDir(dirname(path));
		}

		const existing = fileExists(path) ? readTextFile(path, { encoding }) : "";
		writeTextFile(path, existing + content, { encoding, createDirs: false });
	} catch (error) {
		throw new FileSystemError(
			`Failed to append to file: ${path}`,
			path,
			"append",
			error instanceof Error ? error : undefined,
		);
	}
}

/**
 * Atomic write - write to temp file then rename
 */
export function writeTextFileAtomic(
	path: string,
	content: string,
	options: { encoding?: BufferEncoding } = {},
): void {
	const { encoding = "utf-8" } = options;
	const tempPath = `${path}.tmp.${Date.now()}`;

	try {
		writeTextFile(tempPath, content, { encoding });
		// Rename is atomic on most filesystems
		renameSync(tempPath, path);
	} catch (error) {
		// Clean up temp file if it exists
		try {
			if (fileExists(tempPath)) {
				unlinkSync(tempPath);
			}
		} catch {
			// Ignore cleanup errors
		}
		throw new FileSystemError(
			`Failed to write file atomically: ${path}`,
			path,
			"write-atomic",
			error instanceof Error ? error : undefined,
		);
	}
}
