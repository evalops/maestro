/**
 * SessionMetadataCache - In-memory cache for session metadata
 *
 * Tracks the current model and thinking level without requiring
 * a full re-read of the session file. This is updated as entries
 * are written and seeded from existing files when resuming.
 *
 * This enables efficient access to current settings when displaying
 * status information or making model/thinking level decisions.
 *
 * @module session/metadata-cache
 */

import { existsSync, readFileSync } from "node:fs";
import type { SessionEntry, SessionModelMetadata } from "./types.js";
import { tryParseSessionEntry } from "./types.js";

/**
 * Reads session entries from a file, returning empty array on error
 */
function safeReadSessionEntries(filePath: string): SessionEntry[] {
	try {
		if (!existsSync(filePath)) {
			return [];
		}
		const contents = readFileSync(filePath, "utf8").trim();
		if (!contents) {
			return [];
		}
		const entries: SessionEntry[] = [];
		for (const line of contents.split("\n")) {
			const entry = tryParseSessionEntry(line);
			if (entry) {
				entries.push(entry);
			}
		}
		return entries;
	} catch {
		return [];
	}
}

export type { SessionModelMetadata } from "./types.js";

export class SessionMetadataCache {
	/** Current thinking level: "off", "minimal", "low", "medium", "high", "max" */
	private thinkingLevel = "off";
	/** Current model in format "provider/modelId" (e.g., "anthropic/claude-opus-4-5-20251101") */
	private model: string | null = null;
	/** Full metadata for the current model (capabilities, context window, etc.) */
	private metadata?: SessionModelMetadata;

	/**
	 * Updates the cache based on a session entry.
	 * Called when writing new entries or loading existing sessions.
	 */
	apply(entry: SessionEntry): void {
		if (entry.type === "session") {
			if (typeof entry.thinkingLevel === "string") {
				this.thinkingLevel = entry.thinkingLevel;
			}
			if (typeof entry.model === "string") {
				this.model = entry.model;
			}
			if (entry.modelMetadata) {
				this.metadata = entry.modelMetadata;
			}
			return;
		}
		if (entry.type === "thinking_level_change" && entry.thinkingLevel) {
			this.thinkingLevel = entry.thinkingLevel;
			return;
		}
		if (entry.type === "model_change") {
			if (entry.model) {
				this.model = entry.model;
			}
			if (entry.modelMetadata) {
				this.metadata = entry.modelMetadata;
			}
		}
	}

	/**
	 * Seeds the cache by reading all entries from an existing session file.
	 * @param filePath - Path to the session file
	 */
	seedFromFile(filePath: string): void {
		const entries = safeReadSessionEntries(filePath);
		for (const entry of entries) {
			this.apply(entry);
		}
	}

	getThinkingLevel(): string {
		return this.thinkingLevel;
	}

	getModel(): string | null {
		return this.model;
	}

	getModelMetadata(): SessionModelMetadata | undefined {
		return this.metadata;
	}

	/**
	 * Resets the cache to initial state
	 */
	reset(): void {
		this.thinkingLevel = "off";
		this.model = null;
		this.metadata = undefined;
	}
}
