/**
 * Cross-session memory module.
 *
 * Provides simple JSON-based storage for facts, learnings,
 * and searchable notes that persist across sessions.
 *
 * @example
 * ```typescript
 * import { addMemory, searchMemories, listTopics } from "./memory";
 *
 * // Save a memory
 * addMemory("api-design", "Use kebab-case for REST endpoints", {
 *   tags: ["rest", "naming"],
 * });
 *
 * // Search memories
 * const results = searchMemories("endpoints");
 *
 * // List all topics
 * const topics = listTopics();
 * ```
 */

export {
	addMemory,
	updateMemory,
	deleteMemory,
	deleteTopicMemories,
	searchMemories,
	getTopicMemories,
	getMemory,
	listTopics,
	getStats,
	getRecentMemories,
	exportMemories,
	importMemories,
	clearAllMemories,
} from "./store.js";

export type {
	MemoryEntry,
	MemoryTopic,
	MemorySearchResult,
	MemoryStats,
	MemoryStore,
} from "./types.js";
