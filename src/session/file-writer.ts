/**
 * SessionFileWriter - Buffered JSONL writer for session persistence
 *
 * Batches writes to improve performance while ensuring data integrity.
 * Automatically flushes on process exit to prevent data loss.
 *
 * ## Architecture
 *
 * Writes are buffered in memory until either:
 * - Buffer reaches configured batch size (auto-flush)
 * - Explicit flush() is called
 * - Process exit occurs (signal handlers)
 *
 * Uses synchronous I/O (appendFileSync) to avoid race conditions
 * during rapid write sequences.
 *
 * @module session/file-writer
 */

import { appendFileSync } from "node:fs";
import { SESSION_CONFIG } from "../config/constants.js";
import { createLogger } from "../utils/logger.js";
import type { SessionEntry } from "./types.js";

const logger = createLogger("session:file-writer");

export class SessionFileWriter {
	/** Global registry of all active writers for cleanup on exit */
	private static readonly writers = new Set<SessionFileWriter>();
	/** Tracks if process exit handlers have been registered */
	private static beforeExitRegistered = false;

	/** In-memory buffer of pending writes (JSON strings) */
	private buffer: string[] = [];

	/**
	 * Creates a new session file writer.
	 *
	 * @param filePath - Absolute path to the session file
	 * @param batchSize - Number of entries to buffer before auto-flush
	 */
	constructor(
		private readonly filePath: string,
		private readonly batchSize = SESSION_CONFIG.WRITE_BATCH_SIZE,
	) {
		// Register process exit handlers (once per process)
		SessionFileWriter.registerBeforeExit();
		// Track this writer for cleanup
		SessionFileWriter.writers.add(this);
	}

	/**
	 * Registers process exit handlers to flush all writers.
	 * This ensures no data is lost on unexpected termination.
	 */
	private static registerBeforeExit(): void {
		if (SessionFileWriter.beforeExitRegistered) {
			return;
		}
		SessionFileWriter.beforeExitRegistered = true;

		// Flush all writers on process exit
		const flushAll = (signal?: string) => {
			for (const writer of SessionFileWriter.writers) {
				try {
					writer.flushSync();
				} catch (error) {
					logger.error(
						"Failed to flush session file on exit",
						error instanceof Error ? error : undefined,
						signal ? { signal } : undefined,
					);
				}
			}
		};

		// Don't register signal handlers in test mode - vitest manages process lifecycle
		const isTestMode =
			process.env.VITEST === "true" || process.env.NODE_ENV === "test";

		// Register handlers for various exit scenarios
		if (!isTestMode) {
			process.once("beforeExit", () => flushAll());
			process.once("SIGINT", () => {
				flushAll("SIGINT");
				process.exit(); // Re-emit to allow default shutdown behaviour
			});
			process.once("SIGTERM", () => {
				flushAll("SIGTERM");
				process.exit();
			});
		}
		// Also catch unhandled errors to preserve as much data as possible
		// These are safe to register in test mode as they don't call process.exit()
		process.once("uncaughtException", () => flushAll("uncaughtException"));
		process.once("unhandledRejection", () => flushAll("unhandledRejection"));
	}

	/**
	 * Removes this writer from the global registry.
	 * Call this when the session is complete or being replaced.
	 */
	dispose(): void {
		SessionFileWriter.writers.delete(this);
	}

	/**
	 * Buffers a session entry for later writing.
	 * Auto-flushes when buffer reaches configured batch size.
	 *
	 * @param entry - Session entry to write
	 */
	write(entry: SessionEntry): void {
		this.buffer.push(JSON.stringify(entry));
		if (this.buffer.length >= this.batchSize) {
			this.flushSync();
		}
	}

	/**
	 * Drains the buffer and returns the combined content.
	 * @returns Newline-separated JSON strings, or null if empty
	 */
	private drainBuffer(): string | null {
		if (this.buffer.length === 0) return null;
		const chunk = `${this.buffer.join("\n")}\n`;
		this.buffer = [];
		return chunk;
	}

	/**
	 * Synchronously writes a chunk to the file.
	 * Uses sync I/O to ensure data integrity during rapid writes.
	 */
	private writeChunkSync(chunk: string): void {
		try {
			appendFileSync(this.filePath, chunk);
		} catch (error) {
			logger.error(
				"Failed to write session chunk",
				error instanceof Error ? error : undefined,
				{ filePath: this.filePath },
			);
			throw error;
		}
	}

	/**
	 * Flushes all buffered entries to disk (async wrapper).
	 */
	async flush(): Promise<void> {
		this.flushSync();
	}

	/**
	 * Synchronously flushes all buffered entries to disk.
	 */
	flushSync(): void {
		const chunk = this.drainBuffer();
		if (chunk) {
			this.writeChunkSync(chunk);
		}
	}
}
