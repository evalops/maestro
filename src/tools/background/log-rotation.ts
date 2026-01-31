/**
 * Rotating Log Writer
 *
 * A writable stream that manages log file rotation with gzip compression.
 * Used for background task logging where logs need size limits and archival.
 */

import {
	createReadStream,
	createWriteStream,
	promises as fsPromises,
} from "node:fs";
import { dirname } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import { isErrno } from "../../utils/fs.js";
import { createLogger } from "../../utils/logger.js";

/**
 * Options for creating a RotatingLogWriter.
 */
export interface RotatingLogWriterOptions {
	/** Maximum size in bytes before rotation */
	limit: number;
	/** Number of archived segments to keep (0 = no archival) */
	segments: number;
	/** Path to the active log file */
	logPath: string;
	/** Current size of existing log file */
	existingSize: number;
	/** Callback when output is truncated due to limits */
	markTruncated: () => void;
	/** Callback to shift existing archives (e.g., .1.gz → .2.gz) */
	shiftArchives: () => void;
	/** Function to generate archive path for a given index */
	archivedPath: (index: number) => string;
}

export interface LogRotationInfo {
	logPath: string;
	archivePath: string;
	rotatedAt: number;
}

interface RotationWaiter {
	resolve: (info: LogRotationInfo) => void;
	reject: (error: Error) => void;
	timeoutId?: ReturnType<typeof setTimeout>;
	signal?: AbortSignal;
	abortHandler?: () => void;
}

/**
 * A writable stream that rotates logs when they exceed size limits.
 *
 * Features:
 * - Automatic rotation when log exceeds size limit
 * - Gzip compression of rotated logs
 * - Configurable number of archived segments
 * - Async-safe write queue to prevent race conditions
 * - Graceful handling of filesystem errors
 *
 * @example
 * ```typescript
 * const writer = new RotatingLogWriter({
 *   limit: 5 * 1024 * 1024, // 5MB
 *   segments: 3,
 *   logPath: '/var/log/app.log',
 *   existingSize: 0,
 *   markTruncated: () => console.log('truncated'),
 *   shiftArchives: () => { ... },
 *   archivedPath: (i) => `/var/log/app.log.${i}.gz`,
 * });
 *
 * process.stdout.pipe(writer);
 * ```
 */
export class RotatingLogWriter extends Writable {
	private readonly logger = createLogger("log-rotation");
	private readonly limit: number;
	private readonly segments: number;
	private readonly logPath: string;
	private currentSize: number;
	private readonly markTruncated: () => void;
	private readonly shiftArchives: () => void;
	private readonly archivedPath: (index: number) => string;
	private writeQueue: Promise<void>;
	private readonly dropAll: boolean;
	private readonly ready: Promise<void>;
	private failed = false;
	private lastRotation: LogRotationInfo | null = null;
	private rotationWaiters: RotationWaiter[] = [];

	constructor(options: RotatingLogWriterOptions) {
		super({ decodeStrings: true });
		this.limit = Math.max(options.limit, 0);
		this.segments = Math.max(options.segments, 0);
		this.logPath = options.logPath;
		this.currentSize = Math.min(options.existingSize, this.limit);
		this.markTruncated = options.markTruncated;
		this.shiftArchives = options.shiftArchives;
		this.archivedPath = options.archivedPath;
		this.dropAll = this.limit === 0;
		this.ready = this.initialize();
		this.writeQueue = this.ready;
	}

	override _write(
		chunk: Buffer | string,
		encoding: BufferEncoding,
		callback: (error?: Error | null) => void,
	): void {
		if (this.dropAll || this.failed) {
			this.markTruncated();
			callback();
			return;
		}
		const buffer = Buffer.isBuffer(chunk)
			? chunk
			: Buffer.from(chunk, encoding);
		this.writeQueue = this.writeQueue.then(() => this.writeBuffer(buffer));
		this.writeQueue.then(
			() => callback(),
			(error) => {
				this.handleWriteError(error);
				callback();
			},
		);
	}

	override _final(callback: (error?: Error | null) => void): void {
		this.writeQueue.then(
			() => {
				if (!this.lastRotation) {
					this.rejectRotationWaiters(
						"Log rotation did not occur before stream ended",
					);
				}
				callback();
			},
			(error) => callback(error),
		);
	}

	waitForRotation(options?: {
		timeoutMs?: number;
		signal?: AbortSignal;
	}): Promise<LogRotationInfo> {
		if (this.lastRotation) {
			return Promise.resolve(this.lastRotation);
		}
		if (this.segments <= 0 || this.limit <= 0) {
			return Promise.reject(new Error("Log rotation is disabled"));
		}
		const timeoutMs = options?.timeoutMs ?? 5000;
		return new Promise((resolve, reject) => {
			const waiter: RotationWaiter = {
				resolve: (info) => {
					this.cleanupRotationWaiter(waiter);
					resolve(info);
				},
				reject: (error) => {
					this.cleanupRotationWaiter(waiter);
					reject(error);
				},
			};
			if (timeoutMs > 0) {
				waiter.timeoutId = setTimeout(() => {
					waiter.reject(new Error("Timed out waiting for log rotation"));
				}, timeoutMs);
			}
			if (options?.signal) {
				if (options.signal.aborted) {
					waiter.reject(new Error("Aborted while waiting for log rotation"));
					return;
				}
				waiter.abortHandler = () => {
					waiter.reject(new Error("Aborted while waiting for log rotation"));
				};
				waiter.signal = options.signal;
				options.signal.addEventListener("abort", waiter.abortHandler, {
					once: true,
				});
			}
			this.rotationWaiters.push(waiter);
		});
	}

	private async writeBuffer(buffer: Buffer): Promise<void> {
		if (this.dropAll || this.failed) {
			if (buffer.length > 0) {
				this.markTruncated();
			}
			return;
		}
		let remainingBuffer = buffer;
		while (remainingBuffer.length > 0) {
			if (this.currentSize >= this.limit) {
				const rotated = await this.rotate();
				if (!rotated) {
					this.markTruncated();
					return;
				}
				continue;
			}
			const remainingCapacity = this.limit - this.currentSize;
			if (remainingCapacity <= 0) {
				this.markTruncated();
				return;
			}
			const slice =
				remainingBuffer.length > remainingCapacity
					? remainingBuffer.subarray(0, remainingCapacity)
					: remainingBuffer;
			await this.appendToLog(slice);
			this.currentSize += slice.length;
			remainingBuffer = remainingBuffer.subarray(slice.length);
		}
	}

	private async rotate(): Promise<boolean> {
		if (this.segments <= 0) {
			return false;
		}
		try {
			await this.shiftArchivesAsync();
			const tmpPath = this.getTempArchivePath();
			try {
				await fsPromises.rename(this.logPath, tmpPath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					await this.ensureLogFileExists();
					this.currentSize = 0;
					return true;
				}
				throw error;
			}
			await this.ensureLogFileExists();
			const destination = this.archivedPath(1);
			await pipeline(
				createReadStream(tmpPath),
				createGzip(),
				createWriteStream(destination),
			);
			this.recordRotation({
				logPath: this.logPath,
				archivePath: destination,
				rotatedAt: Date.now(),
			});
			await fsPromises.unlink(tmpPath).catch((err) => {
				this.logger.debug("Failed to unlink temp file after rotation", {
					tmpPath,
					error: err instanceof Error ? err.message : String(err),
				});
			});
			this.currentSize = 0;
			return true;
		} catch (error) {
			this.handleWriteError(error);
			return false;
		}
	}

	private async initialize(): Promise<void> {
		await this.ensureLogFileExists();
		if (this.dropAll) {
			return;
		}
		if (this.limit > 0 && this.currentSize >= this.limit) {
			await this.rotate();
		}
	}

	private async ensureLogFileExists(): Promise<void> {
		try {
			await fsPromises.mkdir(dirname(this.logPath), { recursive: true });
			const handle = await fsPromises.open(this.logPath, "a");
			await handle.close();
		} catch (error: unknown) {
			if (isErrno(error) && error.code === "ENOENT") {
				// Expected when the log file is not yet present; mkdir may race on temp dirs.
				this.logger.debug("Log init ENOENT; will retry", {
					path: this.logPath,
					error,
				});
				return;
			}

			if (error instanceof Error) {
				this.logger.error("Failed to initialize log file", error, {
					path: this.logPath,
				});
			} else {
				this.logger.error("Failed to initialize log file", undefined, {
					path: this.logPath,
					error,
				});
			}
		}
	}

	private async appendToLog(slice: Buffer): Promise<void> {
		try {
			await fsPromises.appendFile(this.logPath, slice);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				await this.ensureLogFileExists();
				await fsPromises.appendFile(this.logPath, slice);
				return;
			}
			throw error;
		}
	}

	private getTempArchivePath(): string {
		return `${this.logPath}.rotating-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	}

	private async shiftArchivesAsync(): Promise<void> {
		await Promise.resolve(this.shiftArchives());
	}

	private recordRotation(info: LogRotationInfo): void {
		this.lastRotation = info;
		const waiters = this.rotationWaiters;
		this.rotationWaiters = [];
		for (const waiter of waiters) {
			waiter.resolve(info);
		}
		this.emit("rotated", info);
	}

	private cleanupRotationWaiter(waiter: RotationWaiter): void {
		if (waiter.timeoutId) {
			clearTimeout(waiter.timeoutId);
		}
		if (waiter.signal && waiter.abortHandler) {
			waiter.signal.removeEventListener("abort", waiter.abortHandler);
			waiter.abortHandler = undefined;
		}
		this.rotationWaiters = this.rotationWaiters.filter(
			(entry) => entry !== waiter,
		);
	}

	private rejectRotationWaiters(reason: string): void {
		if (this.rotationWaiters.length === 0) {
			return;
		}
		const error = new Error(reason);
		const waiters = this.rotationWaiters;
		this.rotationWaiters = [];
		for (const waiter of waiters) {
			waiter.reject(error);
		}
	}

	private handleWriteError(error: unknown): void {
		if (this.failed) {
			return;
		}
		this.failed = true;
		this.markTruncated();
		this.rejectRotationWaiters("Log rotation failed");
		this.logger.warn("Failed to write to log", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
