/**
 * Thread Memory - Conversation context for Slack threads
 *
 * Manages message history per thread for multi-turn conversations.
 * Supports pluggable storage backends (file or Redis).
 *
 * For enterprise/sensitive data:
 * ```typescript
 * const redis = await createRedisBackend({ url: process.env.REDIS_URL });
 * const memory = new ThreadMemoryManager({ storage: redis });
 * ```
 */

import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import * as logger from "./logger.js";
import { FileStorageBackend, type StorageBackend } from "./storage.js";
import { ensureDirSync } from "./utils/fs.js";

// ============================================================================
// Types
// ============================================================================

export interface ThreadMessage {
	id: string;
	role: "user" | "assistant" | "system";
	content: string;
	userId?: string;
	messageTs?: string;
	tokenCount?: number;
	metadata?: {
		toolCalls?: Array<{ name: string; input?: unknown }>;
		model?: string;
		isEdited?: boolean;
		isSummary?: boolean;
		userName?: string;
		displayName?: string;
		attachments?: string[];
		isDeleted?: boolean;
	};
	createdAt: string;
}

export interface ThreadContext {
	channelId: string;
	threadTs: string;
	messages: ThreadMessage[];
	totalTokens: number;
	createdAt: string;
	updatedAt: string;
}

export interface ThreadMemoryConfig {
	maxTokens?: number;
	maxMessages?: number;
	retentionDays?: number;
	/** TTL for stored threads in ms (default: 7 days) */
	ttlMs?: number;
	/** Custom storage backend (file or Redis) */
	storage?: StorageBackend;
}

const DEFAULT_CONFIG = {
	maxTokens: 100000,
	maxMessages: 50,
	retentionDays: 7,
	ttlMs: 7 * 24 * 60 * 60 * 1000, // 7 days
};

// ============================================================================
// Token Estimation
// ============================================================================

function estimateTokens(text: string): number {
	// Rough estimate: ~4 characters per token for English text
	return Math.ceil(text.length / 4);
}

// ============================================================================
// ThreadMemoryManager Class
// ============================================================================

export class ThreadMemoryManager {
	private storage: StorageBackend;
	private config: typeof DEFAULT_CONFIG;
	private memoryDir?: string; // Only for file backend cleanup

	constructor(workingDir: string, config: ThreadMemoryConfig = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };

		// Use provided storage or default to file-based
		if (config.storage) {
			this.storage = config.storage;
		} else {
			this.memoryDir = join(workingDir, "threads");
			ensureDirSync(this.memoryDir);
			this.storage = new FileStorageBackend(this.memoryDir);
		}
	}

	private getKey(channelId: string, threadTs: string): string {
		return `thread:${channelId}:${threadTs}`;
	}

	/**
	 * Get thread context from storage
	 */
	async getContext(
		channelId: string,
		threadTs: string,
	): Promise<ThreadContext> {
		const key = this.getKey(channelId, threadTs);
		const context = await this.storage.get<ThreadContext>(key);

		if (context) {
			return context;
		}

		return this.createEmptyContext(channelId, threadTs);
	}

	/**
	 * Shutdown and flush storage
	 */
	async shutdown(): Promise<void> {
		await this.storage.flush();
	}

	/**
	 * Add a message to thread context
	 */
	async addMessage(
		channelId: string,
		threadTs: string,
		message: Omit<ThreadMessage, "id" | "createdAt">,
	): Promise<ThreadMessage> {
		const context = await this.getContext(channelId, threadTs);

		const newMessage: ThreadMessage = {
			...message,
			id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			tokenCount: message.tokenCount ?? estimateTokens(message.content),
			createdAt: new Date().toISOString(),
		};

		context.messages.push(newMessage);
		context.totalTokens += newMessage.tokenCount ?? 0;
		context.updatedAt = new Date().toISOString();

		// Check limits and trim if needed
		await this.enforceLimit(context);

		// Save
		await this.save(context);

		return newMessage;
	}

	/**
	 * Get messages formatted for the agent
	 */
	async getMessagesForAgent(
		channelId: string,
		threadTs: string,
	): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
		const context = await this.getContext(channelId, threadTs);

		return context.messages
			.filter(
				(m) =>
					(m.role === "user" || m.role === "assistant") &&
					m.metadata?.isDeleted !== true,
			)
			.map((m) => ({
				role: m.role as "user" | "assistant",
				content: m.content,
			}));
	}

	/**
	 * Update a message by its Slack timestamp
	 */
	async updateMessageByTs(
		channelId: string,
		threadTs: string,
		messageTs: string,
		update: {
			content?: string;
			isEdited?: boolean;
			isDeleted?: boolean;
			userId?: string;
		},
	): Promise<void> {
		const context = await this.getContext(channelId, threadTs);
		const target = context.messages.find(
			(m) => m.messageTs === messageTs && m.metadata?.isDeleted !== true,
		);
		if (!target) return;

		if (typeof update.content === "string") {
			const previousTokens =
				target.tokenCount ?? estimateTokens(target.content);
			target.content = update.content;
			target.tokenCount = estimateTokens(target.content);
			context.totalTokens += (target.tokenCount ?? 0) - previousTokens;
		}
		if (update.userId) {
			target.userId = update.userId;
		}
		target.metadata = {
			...(target.metadata ?? {}),
			isEdited: update.isEdited ?? target.metadata?.isEdited,
			isDeleted: update.isDeleted ?? target.metadata?.isDeleted,
		};
		context.updatedAt = new Date().toISOString();
		await this.save(context);
	}

	/**
	 * Mark a message as deleted by Slack timestamp
	 */
	async deleteMessageByTs(
		channelId: string,
		threadTs: string,
		messageTs: string,
	): Promise<void> {
		await this.updateMessageByTs(channelId, threadTs, messageTs, {
			isDeleted: true,
			content: "",
		});
	}

	/**
	 * Clear thread context
	 */
	async clearThread(channelId: string, threadTs: string): Promise<void> {
		const key = this.getKey(channelId, threadTs);
		await this.storage.delete(key);
	}

	/**
	 * Clear all threads for a channel
	 */
	async clearChannel(channelId: string): Promise<void> {
		try {
			const keys = await this.storage.keys(`thread:${channelId}:*`);
			await Promise.all(keys.map((key) => this.storage.delete(key)));
		} catch (error) {
			logger.logWarning(
				"Failed to clear thread memory for channel",
				String(error),
			);
		}
	}

	/**
	 * Get thread summary (message count, token count)
	 */
	async getThreadSummary(
		channelId: string,
		threadTs: string,
	): Promise<{
		messageCount: number;
		totalTokens: number;
		lastMessageAt: string | null;
	}> {
		const context = await this.getContext(channelId, threadTs);

		return {
			messageCount: context.messages.length,
			totalTokens: context.totalTokens,
			lastMessageAt:
				context.messages.length > 0
					? context.messages[context.messages.length - 1].createdAt
					: null,
		};
	}

	/**
	 * Clean up old threads based on retention policy
	 * Note: Only works for file-based storage. Redis uses TTL automatically.
	 */
	async cleanup(): Promise<number> {
		// For file-based storage only
		if (!this.memoryDir) {
			return 0; // Redis handles TTL automatically
		}

		const cutoff = new Date();
		cutoff.setDate(cutoff.getDate() - this.config.retentionDays);
		let deleted = 0;

		try {
			const files = readdirSync(this.memoryDir).filter((f) =>
				f.endsWith(".json"),
			);

			for (const file of files) {
				const filePath = join(this.memoryDir, file);
				try {
					// Read file directly to avoid lossy key reconstruction issues
					// (special chars like : and . both become _ in filenames)
					const content = readFileSync(filePath, "utf-8");
					const data = JSON.parse(content) as {
						value: ThreadContext;
						expiresAt?: number;
					};

					// Check TTL first (storage-level expiration)
					if (data.expiresAt && Date.now() > data.expiresAt) {
						unlinkSync(filePath);
						deleted++;
						continue;
					}

					// Check retention policy based on last update
					const context = data.value;
					if (context?.updatedAt) {
						const updatedAt = new Date(context.updatedAt);
						if (updatedAt < cutoff) {
							unlinkSync(filePath);
							deleted++;
						}
					}
				} catch {
					// Skip invalid files (corrupted JSON, permission issues, etc.)
				}
			}
		} catch (error) {
			logger.logWarning("Failed to cleanup thread memory", String(error));
		}

		if (deleted > 0) {
			logger.logInfo(`Cleaned up old threads: ${deleted} deleted`);
		}

		return deleted;
	}

	private createEmptyContext(
		channelId: string,
		threadTs: string,
	): ThreadContext {
		return {
			channelId,
			threadTs,
			messages: [],
			totalTokens: 0,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
	}

	private async enforceLimit(context: ThreadContext): Promise<void> {
		// Remove oldest messages if over limit
		while (
			context.messages.length > this.config.maxMessages ||
			context.totalTokens > this.config.maxTokens
		) {
			const removed = context.messages.shift();
			if (removed) {
				context.totalTokens -= removed.tokenCount ?? 0;
			} else {
				break;
			}
		}
	}

	private async save(context: ThreadContext): Promise<void> {
		const key = this.getKey(context.channelId, context.threadTs);

		try {
			await this.storage.set(key, context, this.config.ttlMs);
		} catch (error) {
			logger.logWarning("Failed to save thread context", String(error));
		}
	}
}
