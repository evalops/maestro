/**
 * JSON-based memory store for cross-session persistence.
 *
 * Stores memories as JSON files in ~/.composer/memory/
 * with simple text-based search capabilities.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PATHS } from "../config/constants.js";
import { createLogger } from "../utils/logger.js";
import type {
	MemoryEntry,
	MemorySearchResult,
	MemoryStats,
	MemoryStore,
	MemoryTopic,
} from "./types.js";

const logger = createLogger("memory:store");

const MEMORY_DIR = join(PATHS.COMPOSER_HOME, "memory");
const STORE_FILE = join(MEMORY_DIR, "store.json");
const CURRENT_VERSION = 1;

/**
 * Generate a unique memory ID.
 */
function generateId(): string {
	return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Ensure the memory directory exists.
 */
function ensureDir(): void {
	if (!existsSync(MEMORY_DIR)) {
		mkdirSync(MEMORY_DIR, { recursive: true });
	}
}

/**
 * Load the memory store from disk.
 */
function loadStore(): MemoryStore {
	ensureDir();

	if (!existsSync(STORE_FILE)) {
		return { entries: [], version: CURRENT_VERSION };
	}

	try {
		const content = readFileSync(STORE_FILE, "utf-8");
		const store = JSON.parse(content) as MemoryStore;
		return store;
	} catch (error) {
		logger.warn("Failed to load memory store, starting fresh", {
			error: error instanceof Error ? error.message : String(error),
		});
		return { entries: [], version: CURRENT_VERSION };
	}
}

/**
 * Save the memory store to disk.
 */
function saveStore(store: MemoryStore): void {
	ensureDir();

	try {
		writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), "utf-8");
	} catch (error) {
		logger.error(
			"Failed to save memory store",
			error instanceof Error ? error : undefined,
		);
		throw error;
	}
}

/**
 * Add a new memory entry.
 */
export function addMemory(
	topic: string,
	content: string,
	options?: {
		tags?: string[];
		sessionId?: string;
	},
): MemoryEntry {
	const store = loadStore();
	const now = Date.now();

	const entry: MemoryEntry = {
		id: generateId(),
		topic: topic.toLowerCase().trim(),
		content,
		tags: options?.tags?.map((t) => t.toLowerCase().trim()),
		sessionId: options?.sessionId,
		createdAt: now,
		updatedAt: now,
	};

	store.entries.push(entry);
	saveStore(store);

	logger.info("Memory added", { id: entry.id, topic: entry.topic });

	return entry;
}

/**
 * Update an existing memory entry.
 */
export function updateMemory(
	id: string,
	updates: Partial<Pick<MemoryEntry, "content" | "topic" | "tags">>,
): MemoryEntry | null {
	const store = loadStore();
	const index = store.entries.findIndex((e) => e.id === id);

	if (index === -1) {
		return null;
	}

	const entry = store.entries[index];
	if (!entry) {
		return null;
	}
	if (updates.content !== undefined) {
		entry.content = updates.content;
	}
	if (updates.topic !== undefined) {
		entry.topic = updates.topic.toLowerCase().trim();
	}
	if (updates.tags !== undefined) {
		entry.tags = updates.tags.map((t) => t.toLowerCase().trim());
	}
	entry.updatedAt = Date.now();

	saveStore(store);

	return entry;
}

/**
 * Delete a memory entry.
 */
export function deleteMemory(id: string): boolean {
	const store = loadStore();
	const index = store.entries.findIndex((e) => e.id === id);

	if (index === -1) {
		return false;
	}

	store.entries.splice(index, 1);
	saveStore(store);

	logger.info("Memory deleted", { id });

	return true;
}

/**
 * Delete all memories for a topic.
 */
export function deleteTopicMemories(topic: string): number {
	const store = loadStore();
	const normalizedTopic = topic.toLowerCase().trim();
	const before = store.entries.length;

	store.entries = store.entries.filter((e) => e.topic !== normalizedTopic);
	saveStore(store);

	const deleted = before - store.entries.length;
	logger.info("Topic memories deleted", { topic, count: deleted });

	return deleted;
}

/**
 * Search memories using simple text matching.
 */
export function searchMemories(
	query: string,
	options?: {
		topic?: string;
		tags?: string[];
		limit?: number;
	},
): MemorySearchResult[] {
	const store = loadStore();
	const normalizedQuery = query.toLowerCase().trim();
	const results: MemorySearchResult[] = [];

	for (const entry of store.entries) {
		// Filter by topic if specified
		if (options?.topic && entry.topic !== options.topic.toLowerCase()) {
			continue;
		}

		// Filter by tags if specified
		if (options?.tags && options.tags.length > 0) {
			const entryTags = new Set(entry.tags ?? []);
			const hasAllTags = options.tags.every((t) =>
				entryTags.has(t.toLowerCase()),
			);
			if (!hasAllTags) {
				continue;
			}
		}

		// Score based on matches
		let score = 0;
		let matchedOn: "content" | "topic" | "tag" = "content";

		// Check topic match (highest priority)
		if (entry.topic.includes(normalizedQuery)) {
			score += 10;
			matchedOn = "topic";
		}

		// Check tag match
		if (entry.tags?.some((t) => t.includes(normalizedQuery))) {
			score += 5;
			if (matchedOn !== "topic") {
				matchedOn = "tag";
			}
		}

		// Check content match
		const contentLower = entry.content.toLowerCase();
		if (contentLower.includes(normalizedQuery)) {
			// Score based on frequency and position
			const firstIndex = contentLower.indexOf(normalizedQuery);
			const occurrences = contentLower.split(normalizedQuery).length - 1;
			score += 1 + occurrences * 0.5 + (1 - firstIndex / entry.content.length);
		}

		if (score > 0) {
			results.push({ entry, score, matchedOn });
		}
	}

	// Sort by score descending
	results.sort((a, b) => b.score - a.score);

	// Apply limit
	if (options?.limit && options.limit > 0) {
		return results.slice(0, options.limit);
	}

	return results;
}

/**
 * Get all memories for a topic.
 */
export function getTopicMemories(topic: string): MemoryEntry[] {
	const store = loadStore();
	const normalizedTopic = topic.toLowerCase().trim();

	return store.entries
		.filter((e) => e.topic === normalizedTopic)
		.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Get a memory by ID.
 */
export function getMemory(id: string): MemoryEntry | null {
	const store = loadStore();
	return store.entries.find((e) => e.id === id) ?? null;
}

/**
 * List all topics with their stats.
 */
export function listTopics(): MemoryTopic[] {
	const store = loadStore();
	const topicMap = new Map<
		string,
		{ count: number; lastUpdated: number; description?: string }
	>();

	for (const entry of store.entries) {
		const existing = topicMap.get(entry.topic);
		if (existing) {
			existing.count++;
			existing.lastUpdated = Math.max(existing.lastUpdated, entry.updatedAt);
		} else {
			topicMap.set(entry.topic, {
				count: 1,
				lastUpdated: entry.updatedAt,
			});
		}
	}

	return Array.from(topicMap.entries())
		.map(([name, stats]) => ({
			name,
			entryCount: stats.count,
			lastUpdated: stats.lastUpdated,
		}))
		.sort((a, b) => b.lastUpdated - a.lastUpdated);
}

/**
 * Get memory statistics.
 */
export function getStats(): MemoryStats {
	const store = loadStore();

	if (store.entries.length === 0) {
		return {
			totalEntries: 0,
			topics: 0,
			oldestEntry: null,
			newestEntry: null,
		};
	}

	const topics = new Set(store.entries.map((e) => e.topic));
	const timestamps = store.entries.map((e) => e.createdAt);

	return {
		totalEntries: store.entries.length,
		topics: topics.size,
		oldestEntry: Math.min(...timestamps),
		newestEntry: Math.max(...timestamps),
	};
}

/**
 * Get recent memories across all topics.
 */
export function getRecentMemories(limit = 10): MemoryEntry[] {
	const store = loadStore();

	return store.entries
		.slice()
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.slice(0, limit);
}

/**
 * Export all memories for backup.
 */
export function exportMemories(): MemoryStore {
	return loadStore();
}

/**
 * Import memories from backup (merges with existing).
 */
export function importMemories(
	imported: MemoryStore,
	options?: { overwrite?: boolean },
): { added: number; updated: number; skipped: number } {
	const store = options?.overwrite
		? { entries: [], version: CURRENT_VERSION }
		: loadStore();
	const existingIds = new Set(store.entries.map((e) => e.id));

	let added = 0;
	let updated = 0;
	let skipped = 0;

	for (const entry of imported.entries) {
		if (existingIds.has(entry.id)) {
			if (options?.overwrite) {
				const index = store.entries.findIndex((e) => e.id === entry.id);
				store.entries[index] = entry;
				updated++;
			} else {
				skipped++;
			}
		} else {
			store.entries.push(entry);
			added++;
		}
	}

	saveStore(store);

	logger.info("Memories imported", { added, updated, skipped });

	return { added, updated, skipped };
}

/**
 * Clear all memories.
 */
export function clearAllMemories(): number {
	const store = loadStore();
	const count = store.entries.length;

	store.entries = [];
	saveStore(store);

	logger.info("All memories cleared", { count });

	return count;
}
