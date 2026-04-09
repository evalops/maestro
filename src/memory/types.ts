/**
 * Types for cross-session memory system.
 *
 * Provides simple JSON-based storage for facts, learnings,
 * and searchable notes across sessions.
 */

export interface MemoryEntry {
	id: string;
	/** Topic/category for grouping */
	topic: string;
	/** The memory content */
	content: string;
	/** Optional tags for filtering */
	tags?: string[];
	/** Session ID where this was created */
	sessionId?: string;
	/** Repo/project scope identifier when the memory is tied to a git repo */
	projectId?: string;
	/** Human-readable repo/project name for scoped memories */
	projectName?: string;
	/** Timestamp of creation */
	createdAt: number;
	/** Timestamp of last update */
	updatedAt: number;
}

export interface MemoryTopic {
	name: string;
	description?: string;
	entryCount: number;
	lastUpdated: number;
}

export interface MemorySearchResult {
	entry: MemoryEntry;
	score: number;
	matchedOn: "content" | "topic" | "tag";
}

export interface MemoryQueryOptions {
	sessionId?: string;
	projectId?: string;
}

export interface MemorySearchOptions extends MemoryQueryOptions {
	topic?: string;
	tags?: string[];
	limit?: number;
}

export interface MemoryStats {
	totalEntries: number;
	topics: number;
	oldestEntry: number | null;
	newestEntry: number | null;
}

export interface MemoryStore {
	entries: MemoryEntry[];
	version: number;
}
