/**
 * Centralized file system utilities with consistent error handling.
 * Replaces scattered readFileSync/writeFileSync/existsSync calls.
 */

import { randomBytes } from "node:crypto";
import {
	constants,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { access } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { safeJsonParse, safeJsonStringify } from "./json.js";
import { createLogger } from "./logger.js";

const logger = createLogger("fs-utils");

export class FileSystemError extends Error {
	constructor(
		message: string,
		public readonly path: string,
		public readonly operation: string,
		public override readonly cause?: Error,
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
		if (isErrno(error) && error.code === "ENOENT" && createDirs === false) {
			logger.debug("File write failed", { path, error });
		} else {
			logger.error(
				"File write failed",
				error instanceof Error ? error : undefined,
				{ path },
			);
		}
		throw fsError;
	}
}

function isErrno(error: unknown): error is NodeJS.ErrnoException {
	return Boolean(
		error &&
			typeof error === "object" &&
			"code" in error &&
			typeof (error as NodeJS.ErrnoException).code === "string",
	);
}

export { isErrno };

/**
 * Read JSON file with parsing and error handling.
 *
 * When `rotateOnParseFail` is enabled, a file whose content fails to
 * parse as JSON is moved to a `<file>.corrupt.<iso-ts>` sibling
 * before the fallback is returned (#2631). This preserves forensic
 * evidence — instead of silently replacing user data with empty
 * state on the next write — and surfaces the bug in monitoring.
 *
 * The rotation does NOT fire on "file not present" (returns fallback
 * directly) or on "file is empty string" (also returns fallback);
 * it only fires when bytes exist but don't parse.
 */
export function readJsonFile<T = unknown>(
	path: string,
	options: { fallback?: T; rotateOnParseFail?: boolean } = {},
): T {
	const { fallback, rotateOnParseFail = false } = options;

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
				if (rotateOnParseFail) {
					rotateCorruptJsonFile(path);
				}
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
 * Rename a corrupt JSON state file to `<file>.corrupt.<iso-ts>` so
 * subsequent writes create a fresh valid file while the corrupted
 * bytes are preserved for forensics (#2631). Best-effort: failures
 * are logged and swallowed because rotation is a hygiene step, not
 * a load-bearing operation.
 *
 * Returns the rotated path on success, `null` if the source file
 * didn't exist or the rotation failed.
 */
export function rotateCorruptJsonFile(path: string): string | null {
	if (!fileExists(path)) return null;
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	// Append per-call randomness so two processes parsing the same
	// corrupt file in the same millisecond produce different rotated
	// names. `renameSync` overwrites the destination on POSIX, so
	// without the random suffix the second rename would clobber the
	// first's forensic evidence.
	const nonce = randomBytes(4).toString("hex");
	const rotatedPath = `${path}.corrupt.${timestamp}.${nonce}`;
	try {
		renameSync(path, rotatedPath);
		logger.warn("Rotated corrupt JSON file aside; starting fresh", {
			from: path,
			to: rotatedPath,
		});
		return rotatedPath;
	} catch (error) {
		logger.warn("Failed to rotate corrupt JSON file", {
			path,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
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

		writeTextFileAtomic(path, content, { createDirs });
	} catch (error) {
		throw new FileSystemError(
			`Failed to write JSON file: ${path}`,
			path,
			"write-json",
			error instanceof Error ? error : undefined,
		);
	}
}

export function writeJsonFileAtomic(
	path: string,
	data: unknown,
	options: { pretty?: boolean; createDirs?: boolean } = {},
): void {
	writeJsonFile(path, data, options);
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
	options: {
		encoding?: BufferEncoding;
		createDirs?: boolean;
		fsync?: boolean;
		mode?: number;
	} = {},
): void {
	const { encoding = "utf-8", createDirs = true, fsync = true } = options;
	const tempPath = join(
		dirname(path),
		`.${basename(path)}.tmp.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}`,
	);

	try {
		if (createDirs) {
			ensureDir(dirname(path));
		}
		const mode = options.mode ?? existingFileMode(path) ?? 0o600;
		writeFileSync(tempPath, content, { encoding, flag: "wx", mode });
		if (fsync) {
			syncFile(tempPath);
		}
		// Rename is atomic on most filesystems
		renameSync(tempPath, path);
		if (fsync) {
			syncDirectory(dirname(path));
		}
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

function existingFileMode(path: string): number | undefined {
	try {
		if (!fileExists(path)) return undefined;
		return statSync(path).mode & 0o777;
	} catch {
		return undefined;
	}
}

function syncFile(path: string): void {
	const fd = openSync(path, "r+");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function syncDirectory(path: string): void {
	if (process.platform === "win32") return;
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		fsyncSync(fd);
	} catch (error) {
		logger.debug("Directory fsync failed", { path, error });
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch (error) {
				logger.debug("Directory fd close failed", { path, error });
			}
		}
	}
}
