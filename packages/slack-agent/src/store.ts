/**
 * Channel Store - Message logging and attachment management
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as logger from "./logger.js";
import { ensureDirSync } from "./utils/fs.js";

export interface Attachment {
	original: string;
	local: string;
	mimetype?: string;
	filetype?: string;
	size?: number;
}

export interface LoggedMessage {
	date: string;
	ts: string;
	/** Parent thread timestamp - present if this is a thread reply */
	threadTs?: string;
	user: string;
	userName?: string;
	displayName?: string;
	text: string;
	attachments: Attachment[];
	isBot: boolean;
	editedAt?: string;
	isDeleted?: boolean;
}

export interface ChannelStoreConfig {
	workingDir: string;
	botToken: string;
}

interface PendingDownload {
	channelId: string;
	localPath: string;
	url: string;
	size?: number;
	original?: string;
}

export class ChannelStore {
	private workingDir: string;
	private botToken: string;
	private pendingDownloads: PendingDownload[] = [];
	private isDownloading = false;
	private recentlyLogged = new Map<string, number>();
	private lastRecentlyLoggedCleanupMs = 0;
	private readonly recentlyLoggedTtlMs = 60 * 1000;
	private readonly recentlyLoggedCleanupIntervalMs = 15 * 1000;
	private static readonly MAX_ATTACHMENT_DOWNLOAD_BYTES = 25 * 1024 * 1024;
	private static readonly MAX_TOTAL_ATTACHMENT_BYTES = 200 * 1024 * 1024;
	private static readonly DOWNLOAD_TIMEOUT_MS = 15_000;
	private static readonly DOWNLOAD_MAX_ATTEMPTS = 3;
	private attachmentUsageCache = new Map<
		string,
		{ bytes: number; updatedAt: number }
	>();
	private readonly attachmentUsageCacheMs = 10 * 1000;

	constructor(config: ChannelStoreConfig) {
		this.workingDir = config.workingDir;
		this.botToken = config.botToken;
		ensureDirSync(this.workingDir);
	}

	getChannelDir(channelId: string): string {
		const dir = join(this.workingDir, channelId);
		ensureDirSync(dir);
		return dir;
	}

	generateLocalFilename(originalName: string, timestamp: string): string {
		const ts = Math.floor(Number.parseFloat(timestamp) * 1000);
		const sanitized = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
		return `${ts}_${sanitized}`;
	}

	processAttachments(
		channelId: string,
		files: Array<{
			id?: string;
			name?: string;
			url_private_download?: string;
			url_private?: string;
			mimetype?: string;
			filetype?: string;
			size?: number;
		}>,
		timestamp: string,
	): Attachment[] {
		const attachments: Attachment[] = [];

		for (const file of files) {
			const url = file.url_private_download || file.url_private;
			if (!url) {
				logger.logWarning(
					"Attachment missing download URL, skipping",
					file.id ?? file.name ?? "unknown",
				);
				continue;
			}
			const name = file.name ?? (file.id ? `file_${file.id}` : undefined);
			if (!name) {
				logger.logWarning("Attachment missing name, skipping", url);
				continue;
			}

			if (file.size && file.size > ChannelStore.MAX_ATTACHMENT_DOWNLOAD_BYTES) {
				const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
				logger.logWarning(
					"Attachment too large, skipping download",
					`${name} (${sizeMb}MB)`,
				);
				continue;
			}

			const filename = this.generateLocalFilename(name, timestamp);
			const localPath = `${channelId}/attachments/${filename}`;

			attachments.push({
				original: name,
				local: localPath,
				mimetype: file.mimetype,
				filetype: file.filetype,
				size: file.size,
			});

			this.pendingDownloads.push({
				channelId,
				localPath,
				url,
				size: file.size,
				original: name,
			});
		}

		this.processDownloadQueue();
		return attachments;
	}

	/**
	 * Wait for all pending downloads to complete
	 */
	async waitForDownloads(): Promise<void> {
		while (this.pendingDownloads.length > 0 || this.isDownloading) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}

	/**
	 * Check if a file type is likely code or text that should be read
	 */
	isCodeOrTextFile(attachment: Attachment): boolean {
		const codeExtensions = [
			".js",
			".ts",
			".jsx",
			".tsx",
			".py",
			".rb",
			".go",
			".rs",
			".java",
			".c",
			".cpp",
			".h",
			".hpp",
			".cs",
			".php",
			".swift",
			".kt",
			".scala",
			".sh",
			".bash",
			".zsh",
			".fish",
			".ps1",
			".sql",
			".json",
			".yaml",
			".yml",
			".xml",
			".html",
			".css",
			".scss",
			".sass",
			".less",
			".md",
			".txt",
			".csv",
			".toml",
			".ini",
			".conf",
			".cfg",
			".env",
			".gitignore",
			".dockerignore",
			".editorconfig",
			".prettierrc",
			".eslintrc",
		];

		const name = attachment.original.toLowerCase();
		if (codeExtensions.some((ext) => name.endsWith(ext))) {
			return true;
		}

		// Check mimetype
		if (attachment.mimetype) {
			const textMimes = [
				"text/",
				"application/json",
				"application/xml",
				"application/javascript",
				"application/typescript",
				"application/x-yaml",
			];
			if (textMimes.some((m) => attachment.mimetype?.startsWith(m))) {
				return true;
			}
		}

		// Check Slack filetype
		if (attachment.filetype) {
			const textTypes = [
				"text",
				"javascript",
				"python",
				"ruby",
				"go",
				"rust",
				"java",
				"c",
				"cpp",
				"csharp",
				"php",
				"swift",
				"kotlin",
				"scala",
				"shell",
				"sql",
				"json",
				"yaml",
				"xml",
				"html",
				"css",
				"markdown",
				"csv",
			];
			if (textTypes.includes(attachment.filetype)) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Read file content if it's a code/text file and small enough
	 */
	readAttachmentContent(
		attachment: Attachment,
		maxSize = 100000,
	): string | null {
		if (!this.isCodeOrTextFile(attachment)) {
			return null;
		}

		// Skip large files
		if (attachment.size && attachment.size > maxSize) {
			return null;
		}

		const filePath = join(this.workingDir, attachment.local);
		if (!existsSync(filePath)) {
			return null;
		}

		try {
			const content = readFileSync(filePath, "utf-8");
			// Double-check size after reading
			if (content.length > maxSize) {
				return null;
			}
			return content;
		} catch {
			return null;
		}
	}

	async logMessage(
		channelId: string,
		message: LoggedMessage,
	): Promise<boolean> {
		const now = Date.now();
		if (
			now - this.lastRecentlyLoggedCleanupMs >
			this.recentlyLoggedCleanupIntervalMs
		) {
			const cutoff = now - this.recentlyLoggedTtlMs;
			for (const [key, timestamp] of this.recentlyLogged.entries()) {
				if (timestamp < cutoff) {
					this.recentlyLogged.delete(key);
				}
			}
			this.lastRecentlyLoggedCleanupMs = now;
		}

		const dedupeKey = `${channelId}:${message.ts}`;
		if (this.recentlyLogged.has(dedupeKey)) {
			return false;
		}

		this.recentlyLogged.set(dedupeKey, now);

		const logPath = join(this.getChannelDir(channelId), "log.jsonl");

		if (!message.date) {
			let date: Date;
			if (message.ts.includes(".")) {
				date = new Date(Number.parseFloat(message.ts) * 1000);
			} else {
				date = new Date(Number.parseInt(message.ts, 10));
			}
			message.date = date.toISOString();
		}

		const line = `${JSON.stringify(message)}\n`;
		await appendFile(logPath, line, "utf-8");
		return true;
	}

	async logBotResponse(
		channelId: string,
		text: string,
		ts: string,
	): Promise<void> {
		await this.logMessage(channelId, {
			date: new Date().toISOString(),
			ts,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
	}

	getLastTimestamp(channelId: string): string | null {
		const logPath = join(this.workingDir, channelId, "log.jsonl");
		if (!existsSync(logPath)) {
			return null;
		}

		try {
			const content = readFileSync(logPath, "utf-8");
			const lines = content.trim().split("\n");
			if (lines.length === 0 || lines[0] === "") {
				return null;
			}
			const lastLine = lines[lines.length - 1];
			const message = JSON.parse(lastLine) as LoggedMessage;
			return message.ts;
		} catch {
			return null;
		}
	}

	private async processDownloadQueue(): Promise<void> {
		if (this.isDownloading || this.pendingDownloads.length === 0) return;

		this.isDownloading = true;

		while (this.pendingDownloads.length > 0) {
			const item = this.pendingDownloads.shift();
			if (!item) break;

			try {
				await this.downloadAttachment(item);
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				logger.logWarning(
					"Failed to download attachment",
					`${item.localPath}: ${errorMsg}`,
				);
			}
		}

		this.isDownloading = false;
	}

	private getAttachmentUsageBytes(channelId: string): number {
		const cached = this.attachmentUsageCache.get(channelId);
		const now = Date.now();
		if (cached && now - cached.updatedAt < this.attachmentUsageCacheMs) {
			return cached.bytes;
		}

		const attachmentsDir = join(this.workingDir, channelId, "attachments");
		let total = 0;
		try {
			const entries = readdirSync(attachmentsDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isFile()) continue;
				const filePath = join(attachmentsDir, entry.name);
				try {
					total += statSync(filePath).size;
				} catch {
					// ignore individual stat errors
				}
			}
		} catch {
			// directory missing or unreadable
		}

		this.attachmentUsageCache.set(channelId, { bytes: total, updatedAt: now });
		return total;
	}

	private async downloadAttachment(item: PendingDownload): Promise<void> {
		const { localPath, url, size, original } = item;
		const filePath = join(this.workingDir, localPath);

		const dir = join(
			this.workingDir,
			localPath.substring(0, localPath.lastIndexOf("/")),
		);
		ensureDirSync(dir);

		if (size && size > ChannelStore.MAX_ATTACHMENT_DOWNLOAD_BYTES) {
			const sizeMb = (size / (1024 * 1024)).toFixed(1);
			throw new Error(`Attachment exceeds max size (${sizeMb}MB)`);
		}

		const channelId = item.channelId;
		const existingBytes = this.getAttachmentUsageBytes(channelId);
		if (
			size &&
			existingBytes + size > ChannelStore.MAX_TOTAL_ATTACHMENT_BYTES
		) {
			const limitMb = (
				ChannelStore.MAX_TOTAL_ATTACHMENT_BYTES /
				(1024 * 1024)
			).toFixed(0);
			throw new Error(`Attachment storage limit exceeded (${limitMb}MB)`);
		}

		const buffer = await this.downloadBufferWithRetry(url);

		if (
			existingBytes + buffer.byteLength >
			ChannelStore.MAX_TOTAL_ATTACHMENT_BYTES
		) {
			const limitMb = (
				ChannelStore.MAX_TOTAL_ATTACHMENT_BYTES /
				(1024 * 1024)
			).toFixed(0);
			throw new Error(`Attachment storage limit exceeded (${limitMb}MB)`);
		}

		await writeFile(filePath, Buffer.from(buffer));
		this.attachmentUsageCache.set(channelId, {
			bytes: existingBytes + buffer.byteLength,
			updatedAt: Date.now(),
		});

		if (original) {
			logger.logInfo(`Downloaded attachment ${original} → ${localPath}`);
		} else {
			logger.logInfo(`Downloaded attachment ${localPath}`);
		}
	}

	private async downloadBufferWithRetry(url: string): Promise<ArrayBuffer> {
		let lastError: unknown;
		for (
			let attempt = 1;
			attempt <= ChannelStore.DOWNLOAD_MAX_ATTEMPTS;
			attempt += 1
		) {
			const controller = new AbortController();
			const timeoutId = setTimeout(
				() => controller.abort(),
				ChannelStore.DOWNLOAD_TIMEOUT_MS,
			);
			try {
				const response = await fetch(url, {
					headers: {
						Authorization: `Bearer ${this.botToken}`,
					},
					signal: controller.signal,
				});

				if (!response.ok) {
					const error = markNonRetryable(
						new Error(`HTTP ${response.status}: ${response.statusText}`),
					);
					if (
						shouldRetryStatus(response.status) &&
						attempt < ChannelStore.DOWNLOAD_MAX_ATTEMPTS
					) {
						(error as RetryableError).retryable = true;
					}
					if ((error as RetryableError).retryable !== true) {
						throw error;
					}
					const retryAfter = parseRetryAfter(
						response.headers.get("retry-after"),
					);
					const delayMs =
						retryAfter ?? jitterDelay(Math.min(1000 * 2 ** attempt, 8000), 250);
					await wait(delayMs);
					lastError = error;
					continue;
				}

				const contentLength = response.headers.get("content-length");
				if (contentLength) {
					const parsed = Number.parseInt(contentLength, 10);
					if (
						Number.isFinite(parsed) &&
						parsed > ChannelStore.MAX_ATTACHMENT_DOWNLOAD_BYTES
					) {
						const sizeMb = (parsed / (1024 * 1024)).toFixed(1);
						throw markNonRetryable(
							new Error(`Attachment exceeds max size (${sizeMb}MB)`),
						);
					}
				}

				const buffer = await response.arrayBuffer();
				if (buffer.byteLength > ChannelStore.MAX_ATTACHMENT_DOWNLOAD_BYTES) {
					const sizeMb = (buffer.byteLength / (1024 * 1024)).toFixed(1);
					throw markNonRetryable(
						new Error(`Attachment exceeds max size (${sizeMb}MB)`),
					);
				}
				return buffer;
			} catch (error) {
				if (
					error instanceof Error &&
					(error as RetryableError).retryable === false
				) {
					throw error;
				}
				lastError = error;
				if (attempt >= ChannelStore.DOWNLOAD_MAX_ATTEMPTS) {
					break;
				}
				const delayMs = jitterDelay(Math.min(1000 * 2 ** attempt, 8000), 250);
				await wait(delayMs);
			} finally {
				clearTimeout(timeoutId);
			}
		}

		if (lastError instanceof Error) {
			throw lastError;
		}
		throw new Error("Failed to download attachment");
	}

	/**
	 * Update a logged message (for edits)
	 */
	async updateMessage(
		channelId: string,
		ts: string,
		updates: {
			text?: string;
			attachments?: Attachment[];
			editedAt?: string;
		},
	): Promise<void> {
		const dir = this.getChannelDir(channelId);
		const logPath = join(dir, "log.jsonl");
		if (!existsSync(logPath)) return;

		try {
			const content = readFileSync(logPath, "utf-8");
			const lines = content.split("\n");
			let updated = false;
			const updatedLines = lines.map((line) => {
				if (!line.trim()) {
					return line;
				}
				try {
					const msg = JSON.parse(line) as LoggedMessage;
					if (msg.ts === ts) {
						if (typeof updates.text === "string") {
							msg.text = updates.text;
						}
						if (updates.attachments) {
							msg.attachments = updates.attachments;
						}
						msg.editedAt = updates.editedAt ?? new Date().toISOString();
						msg.isDeleted = false;
						updated = true;
						return JSON.stringify(msg);
					}
					return line;
				} catch {
					return line;
				}
			});

			if (updated) {
				const nextContent = updatedLines.join("\n");
				await writeFile(logPath, nextContent);
			}
		} catch (error) {
			logger.logWarning("Failed to update logged message", String(error));
		}
	}

	/**
	 * Mark a logged message as deleted
	 */
	async deleteMessage(channelId: string, ts: string): Promise<void> {
		const dir = this.getChannelDir(channelId);
		const logPath = join(dir, "log.jsonl");
		if (!existsSync(logPath)) return;

		try {
			const content = readFileSync(logPath, "utf-8");
			const lines = content.split("\n");
			let updated = false;
			const updatedLines = lines.map((line) => {
				if (!line.trim()) {
					return line;
				}
				try {
					const msg = JSON.parse(line) as LoggedMessage;
					if (msg.ts === ts) {
						msg.text = "";
						msg.attachments = [];
						msg.isDeleted = true;
						msg.editedAt = msg.editedAt ?? new Date().toISOString();
						updated = true;
						return JSON.stringify(msg);
					}
					return line;
				} catch {
					return line;
				}
			});

			if (updated) {
				const nextContent = updatedLines.join("\n");
				await writeFile(logPath, nextContent);
			}
		} catch (error) {
			logger.logWarning("Failed to delete logged message", String(error));
		}
	}

	/**
	 * Clear conversation history for a channel
	 * Backs up old log before clearing
	 */
	async clearHistory(channelId: string): Promise<void> {
		const dir = this.getChannelDir(channelId);
		const logPath = join(dir, "log.jsonl");

		if (existsSync(logPath)) {
			// Backup old log with timestamp
			const backupPath = join(dir, `log.${Date.now()}.jsonl.bak`);
			const content = readFileSync(logPath, "utf-8");
			await writeFile(backupPath, content);

			// Clear the log
			await writeFile(logPath, "");
		}

		// Clear recent log cache for this channel
		for (const key of this.recentlyLogged.keys()) {
			if (key.startsWith(`${channelId}:`)) {
				this.recentlyLogged.delete(key);
			}
		}
	}
}

function shouldRetryStatus(status: number): boolean {
	return (
		status === 408 ||
		status === 425 ||
		status === 429 ||
		(status >= 500 && status < 600)
	);
}

type RetryableError = Error & { retryable?: boolean };

function markNonRetryable(error: Error): Error {
	(error as RetryableError).retryable = false;
	return error;
}

function parseRetryAfter(value: string | null): number | null {
	if (!value) return null;
	const seconds = Number.parseInt(value, 10);
	if (!Number.isNaN(seconds)) {
		return seconds * 1000;
	}
	const date = Date.parse(value);
	if (!Number.isNaN(date)) {
		return Math.max(date - Date.now(), 0);
	}
	return null;
}

function jitterDelay(baseMs: number, jitterMs: number): number {
	const jitter = Math.floor(Math.random() * jitterMs);
	return baseMs + jitter;
}

function wait(ms: number): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve) => setTimeout(resolve, ms));
}
