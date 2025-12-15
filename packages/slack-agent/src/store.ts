/**
 * Channel Store - Message logging and attachment management
 */

import { existsSync, readFileSync } from "node:fs";
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
}

export interface ChannelStoreConfig {
	workingDir: string;
	botToken: string;
}

interface PendingDownload {
	channelId: string;
	localPath: string;
	url: string;
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
			if (!url) continue;
			if (!file.name) {
				logger.logWarning("Attachment missing name, skipping", url);
				continue;
			}

			const filename = this.generateLocalFilename(file.name, timestamp);
			const localPath = `${channelId}/attachments/${filename}`;

			attachments.push({
				original: file.name,
				local: localPath,
				mimetype: file.mimetype,
				filetype: file.filetype,
				size: file.size,
			});

			this.pendingDownloads.push({ channelId, localPath, url });
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
				await this.downloadAttachment(item.localPath, item.url);
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

	private async downloadAttachment(
		localPath: string,
		url: string,
	): Promise<void> {
		const filePath = join(this.workingDir, localPath);

		const dir = join(
			this.workingDir,
			localPath.substring(0, localPath.lastIndexOf("/")),
		);
		ensureDirSync(dir);

		const response = await fetch(url, {
			headers: {
				Authorization: `Bearer ${this.botToken}`,
			},
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const buffer = await response.arrayBuffer();
		await writeFile(filePath, Buffer.from(buffer));
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
