/**
 * Security Event Store - File-based persistence for security events
 *
 * Provides durable storage for security events using append-only JSONL files.
 * Supports automatic rotation and retention policies.
 *
 * @module telemetry/security-event-store
 */

import { createReadStream, existsSync } from "node:fs";
import {
	appendFile,
	mkdir,
	open,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { PATHS } from "../config/constants.js";
import { createLogger } from "../utils/logger.js";
import type { SecurityEvent } from "./security-events.js";

// Lazy logger to avoid module initialization issues
let _logger: ReturnType<typeof createLogger> | undefined;
function getLogger() {
	if (!_logger) {
		_logger = createLogger("telemetry:security-store");
	}
	return _logger;
}

/**
 * Simple advisory file lock implementation
 * Uses a .lock file with process ID to prevent concurrent writes
 */
class FileLock {
	private lockPath: string;
	private acquired = false;
	private lockTimeout = 5000; // 5 second lock timeout

	constructor(filePath: string) {
		this.lockPath = `${filePath}.lock`;
	}

	/**
	 * Acquire the lock with timeout
	 */
	async acquire(): Promise<boolean> {
		const startTime = Date.now();

		while (Date.now() - startTime < this.lockTimeout) {
			try {
				// Try to check if lock exists and is stale
				if (existsSync(this.lockPath)) {
					const stats = await stat(this.lockPath).catch(() => null);
					if (stats) {
						const age = Date.now() - stats.mtime.getTime();
						// If lock is older than 30 seconds, consider it stale
						if (age > 30_000) {
							await unlink(this.lockPath).catch(() => {});
						} else {
							// Lock exists and is fresh, wait and retry
							await new Promise((r) => setTimeout(r, 50));
							continue;
						}
					}
				}

				// Try to create lock file exclusively
				const handle = await open(this.lockPath, "wx");
				await handle.write(`${process.pid}\n${Date.now()}`);
				await handle.close();
				this.acquired = true;
				return true;
			} catch (err) {
				// EEXIST means another process created the file first
				if ((err as NodeJS.ErrnoException).code === "EEXIST") {
					await new Promise((r) => setTimeout(r, 50));
					continue;
				}
				// Other errors - log and return false
				getLogger().debug("Failed to acquire lock", {
					error: err instanceof Error ? err.message : String(err),
				});
				return false;
			}
		}

		return false;
	}

	/**
	 * Release the lock
	 */
	async release(): Promise<void> {
		if (this.acquired) {
			try {
				await unlink(this.lockPath);
			} catch {
				// Ignore errors during release
			}
			this.acquired = false;
		}
	}
}

/**
 * Execute a function with file locking
 */
async function withFileLock<T>(
	filePath: string,
	fn: () => Promise<T>,
): Promise<T> {
	const lock = new FileLock(filePath);
	const acquired = await lock.acquire();

	if (!acquired) {
		getLogger().warn("Could not acquire file lock, proceeding without lock", {
			path: filePath,
		});
	}

	try {
		return await fn();
	} finally {
		await lock.release();
	}
}

/**
 * Configuration for security event storage
 */
export interface SecurityStoreConfig {
	/** Maximum file size before rotation (bytes). Default: 10MB */
	maxFileSizeBytes: number;
	/** Number of rotated files to keep. Default: 3 */
	maxRotatedFiles: number;
	/** Retention period in milliseconds. Default: 7 days */
	retentionMs: number;
}

const DEFAULT_CONFIG: SecurityStoreConfig = {
	maxFileSizeBytes: 10 * 1024 * 1024, // 10MB
	maxRotatedFiles: 3,
	retentionMs: 7 * 24 * 60 * 60 * 1000, // 7 days
};

/**
 * Get the path to the security events log file
 */
export function getSecurityEventsPath(): string {
	return join(PATHS.MAESTRO_HOME, "security-events.jsonl");
}

/**
 * Get the path to a rotated security events file
 */
function getRotatedPath(index: number): string {
	return join(PATHS.MAESTRO_HOME, `security-events.${index}.jsonl`);
}

/**
 * Ensure the storage directory exists
 */
async function ensureDirectory(): Promise<void> {
	const dir = dirname(getSecurityEventsPath());
	if (!existsSync(dir)) {
		await mkdir(dir, { recursive: true });
	}
}

/**
 * Persist a security event to disk
 *
 * Events are appended as newline-delimited JSON for efficient writes
 * and easy streaming reads. Uses file locking to prevent race conditions.
 */
export async function persistSecurityEvent(
	event: SecurityEvent,
	config: Partial<SecurityStoreConfig> = {},
): Promise<void> {
	const fullConfig = { ...DEFAULT_CONFIG, ...config };
	const filePath = getSecurityEventsPath();

	try {
		await ensureDirectory();

		// Use file locking for atomic rotation + append
		await withFileLock(filePath, async () => {
			// Check if rotation is needed
			await rotateIfNeededInternal(fullConfig);

			// Append event as JSONL
			const line = `${JSON.stringify(event)}\n`;
			await appendFile(filePath, line, "utf-8");
		});
	} catch (err) {
		getLogger().error(
			"Failed to persist security event",
			err instanceof Error ? err : new Error(String(err)),
		);
	}
}

/**
 * Persist multiple security events in batch
 * Uses file locking for thread safety
 */
export async function persistSecurityEvents(
	events: SecurityEvent[],
	config: Partial<SecurityStoreConfig> = {},
): Promise<void> {
	if (events.length === 0) return;

	const fullConfig = { ...DEFAULT_CONFIG, ...config };
	const filePath = getSecurityEventsPath();

	try {
		await ensureDirectory();

		await withFileLock(filePath, async () => {
			await rotateIfNeededInternal(fullConfig);
			const lines = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
			await appendFile(filePath, lines, "utf-8");
		});
	} catch (err) {
		getLogger().error(
			"Failed to persist security events batch",
			err instanceof Error ? err : new Error(String(err)),
		);
	}
}

/**
 * Internal rotation function (assumes lock is held)
 */
async function rotateIfNeededInternal(
	fullConfig: SecurityStoreConfig,
): Promise<boolean> {
	const currentPath = getSecurityEventsPath();

	try {
		if (!existsSync(currentPath)) {
			return false;
		}

		const stats = await stat(currentPath);
		if (stats.size < fullConfig.maxFileSizeBytes) {
			return false;
		}

		getLogger().info("Rotating security events log", {
			currentSize: stats.size,
			maxSize: fullConfig.maxFileSizeBytes,
		});

		// Rotate existing files (delete oldest, shift others)
		for (let i = fullConfig.maxRotatedFiles - 1; i >= 0; i--) {
			const oldPath = i === 0 ? currentPath : getRotatedPath(i);
			const newPath = getRotatedPath(i + 1);

			if (existsSync(oldPath)) {
				if (i === fullConfig.maxRotatedFiles - 1) {
					// Delete the oldest file
					await unlink(oldPath);
				} else {
					// Shift to next index
					await rename(oldPath, newPath);
				}
			}
		}

		return true;
	} catch (err) {
		getLogger().error(
			"Failed to rotate security events log",
			err instanceof Error ? err : new Error(String(err)),
		);
		return false;
	}
}

/**
 * Rotate the log file if it exceeds the size limit
 * Public API with file locking
 */
export async function rotateIfNeeded(
	config: Partial<SecurityStoreConfig> = {},
): Promise<boolean> {
	const fullConfig = { ...DEFAULT_CONFIG, ...config };
	const filePath = getSecurityEventsPath();

	return withFileLock(filePath, () => rotateIfNeededInternal(fullConfig));
}

/**
 * Load recent security events from disk
 *
 * Reads events from the current file and optionally from rotated files.
 * Events are returned in chronological order (oldest first).
 *
 * @param limit - Maximum number of events to return
 * @param includeRotated - Whether to include events from rotated files
 */
export async function loadRecentEvents(
	limit = 100,
	includeRotated = false,
): Promise<SecurityEvent[]> {
	const events: SecurityEvent[] = [];
	const filesToRead: string[] = [getSecurityEventsPath()];

	if (includeRotated) {
		// Add rotated files in reverse order (newest first)
		for (let i = 1; i <= DEFAULT_CONFIG.maxRotatedFiles; i++) {
			const rotatedPath = getRotatedPath(i);
			if (existsSync(rotatedPath)) {
				filesToRead.push(rotatedPath);
			}
		}
	}

	// Read files in reverse order so we get newest events last
	for (const filePath of filesToRead.reverse()) {
		if (!existsSync(filePath)) continue;

		try {
			const fileEvents = await readEventsFromFile(filePath);
			events.push(...fileEvents);
		} catch (err) {
			getLogger().error(
				"Failed to read security events file",
				err instanceof Error ? err : new Error(String(err)),
				{ path: filePath },
			);
		}
	}

	// Return most recent events
	return events.slice(-limit);
}

/**
 * Read all events from a single JSONL file
 */
async function readEventsFromFile(filePath: string): Promise<SecurityEvent[]> {
	const events: SecurityEvent[] = [];

	const fileStream = createReadStream(filePath, { encoding: "utf-8" });
	const rl = createInterface({
		input: fileStream,
		crlfDelay: Number.POSITIVE_INFINITY,
	});

	for await (const line of rl) {
		if (!line.trim()) continue;

		try {
			const event = JSON.parse(line) as SecurityEvent;
			events.push(event);
		} catch {
			// Skip malformed lines
		}
	}

	return events;
}

/**
 * Apply retention policy - delete events older than retention period
 */
export async function applyRetentionPolicy(
	config: Partial<SecurityStoreConfig> = {},
): Promise<number> {
	const fullConfig = { ...DEFAULT_CONFIG, ...config };
	const cutoff = Date.now() - fullConfig.retentionMs;
	let deletedCount = 0;

	// Delete old rotated files entirely
	for (let i = 1; i <= fullConfig.maxRotatedFiles; i++) {
		const rotatedPath = getRotatedPath(i);
		if (!existsSync(rotatedPath)) continue;

		try {
			const stats = await stat(rotatedPath);
			if (stats.mtime.getTime() < cutoff) {
				await unlink(rotatedPath);
				deletedCount++;
				getLogger().info("Deleted old rotated security events file", {
					path: rotatedPath,
				});
			}
		} catch (err) {
			getLogger().error(
				"Failed to check/delete rotated file",
				err instanceof Error ? err : new Error(String(err)),
			);
		}
	}

	return deletedCount;
}

/**
 * Get storage statistics
 */
export async function getStoreStats(): Promise<{
	currentFileSize: number;
	rotatedFilesCount: number;
	totalSize: number;
	oldestEventTimestamp: number | null;
}> {
	let currentFileSize = 0;
	let rotatedFilesCount = 0;
	let totalSize = 0;
	let oldestEventTimestamp: number | null = null;

	const currentPath = getSecurityEventsPath();
	if (existsSync(currentPath)) {
		const stats = await stat(currentPath);
		currentFileSize = stats.size;
		totalSize += stats.size;
	}

	for (let i = 1; i <= DEFAULT_CONFIG.maxRotatedFiles; i++) {
		const rotatedPath = getRotatedPath(i);
		if (existsSync(rotatedPath)) {
			rotatedFilesCount++;
			const stats = await stat(rotatedPath);
			totalSize += stats.size;
		}
	}

	// Get oldest event timestamp from oldest file
	const events = await loadRecentEvents(1, true);
	if (events.length > 0) {
		oldestEventTimestamp = events[0]?.timestamp ?? null;
	}

	return {
		currentFileSize,
		rotatedFilesCount,
		totalSize,
		oldestEventTimestamp,
	};
}

/**
 * Clear all security events (for testing)
 */
export async function clearSecurityEvents(): Promise<void> {
	const currentPath = getSecurityEventsPath();

	if (existsSync(currentPath)) {
		await unlink(currentPath);
	}

	for (let i = 1; i <= DEFAULT_CONFIG.maxRotatedFiles; i++) {
		const rotatedPath = getRotatedPath(i);
		if (existsSync(rotatedPath)) {
			await unlink(rotatedPath);
		}
	}
}
