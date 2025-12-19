/**
 * Agent Resume Capability
 *
 * Enables agents (particularly subagents) to be resumed from a previous execution
 * transcript. This is useful for:
 * - Continuing interrupted agent tasks
 * - Building on previous analysis
 * - Maintaining context across sessions
 */

import { randomUUID } from "node:crypto";
import {
	constants,
	access,
	mkdir,
	readFile,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveEnvPath } from "../utils/path-expansion.js";
import type { AppMessage, Message } from "./types.js";

/**
 * Represents a saved agent execution state.
 */
export interface AgentTranscript {
	/** Unique identifier for this transcript */
	id: string;
	/** Agent type (e.g., "explore", "plan", "review") */
	agentType: string;
	/** When the agent started */
	startedAt: number;
	/** When the agent last updated */
	updatedAt: number;
	/** The original task/prompt */
	originalPrompt: string;
	/** System prompt used */
	systemPrompt: string;
	/** Model used */
	model: string;
	/** Conversation messages */
	messages: AppMessage[];
	/** Whether the agent completed its task */
	completed: boolean;
	/** Final result if completed */
	result?: string;
	/** Error if failed */
	error?: string;
	/** Custom metadata */
	metadata?: Record<string, unknown>;
}

/**
 * Storage interface for agent transcripts.
 */
export interface TranscriptStore {
	/** Save a transcript */
	save(transcript: AgentTranscript): Promise<void>;
	/** Load a transcript by ID */
	load(id: string): Promise<AgentTranscript | null>;
	/** List recent transcripts */
	list(options?: { agentType?: string; limit?: number }): Promise<
		AgentTranscript[]
	>;
	/** Delete a transcript */
	delete(id: string): Promise<void>;
}

/**
 * File-based transcript storage.
 */
export class FileTranscriptStore implements TranscriptStore {
	private baseDir: string;

	constructor(baseDir?: string) {
		this.baseDir =
			baseDir ||
			join(
				resolveEnvPath(process.env.COMPOSER_DATA_DIR) ??
					resolveEnvPath(process.env.HOME) ??
					"/tmp",
				".composer",
				"transcripts",
			);
	}

	private getPath(id: string): string {
		return join(this.baseDir, `${id}.json`);
	}

	async save(transcript: AgentTranscript): Promise<void> {
		const path = this.getPath(transcript.id);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify(transcript, null, 2));
	}

	async load(id: string): Promise<AgentTranscript | null> {
		const path = this.getPath(id);
		try {
			await access(path, constants.R_OK);
			const content = await readFile(path, "utf-8");
			return JSON.parse(content) as AgentTranscript;
		} catch {
			return null;
		}
	}

	async list(options?: { agentType?: string; limit?: number }): Promise<
		AgentTranscript[]
	> {
		const { agentType, limit = 100 } = options || {};
		const { readdir } = await import("node:fs/promises");

		try {
			const files = await readdir(this.baseDir);
			const transcripts: AgentTranscript[] = [];

			for (const file of files) {
				if (!file.endsWith(".json")) continue;
				const id = file.replace(".json", "");
				const transcript = await this.load(id);
				if (transcript) {
					if (!agentType || transcript.agentType === agentType) {
						transcripts.push(transcript);
					}
				}
				if (transcripts.length >= limit) break;
			}

			// Sort by updatedAt descending
			transcripts.sort((a, b) => b.updatedAt - a.updatedAt);
			return transcripts.slice(0, limit);
		} catch {
			return [];
		}
	}

	async delete(id: string): Promise<void> {
		const { unlink } = await import("node:fs/promises");
		try {
			await unlink(this.getPath(id));
		} catch {
			// Ignore if file doesn't exist
		}
	}
}

/**
 * In-memory transcript storage (useful for testing).
 */
export class MemoryTranscriptStore implements TranscriptStore {
	private transcripts: Map<string, AgentTranscript> = new Map();

	async save(transcript: AgentTranscript): Promise<void> {
		this.transcripts.set(transcript.id, { ...transcript });
	}

	async load(id: string): Promise<AgentTranscript | null> {
		const transcript = this.transcripts.get(id);
		return transcript ? { ...transcript } : null;
	}

	async list(options?: { agentType?: string; limit?: number }): Promise<
		AgentTranscript[]
	> {
		const { agentType, limit = 100 } = options || {};
		let results = Array.from(this.transcripts.values());

		if (agentType) {
			results = results.filter((t) => t.agentType === agentType);
		}

		results.sort((a, b) => b.updatedAt - a.updatedAt);
		return results.slice(0, limit);
	}

	async delete(id: string): Promise<void> {
		this.transcripts.delete(id);
	}

	clear(): void {
		this.transcripts.clear();
	}
}

/**
 * Create a new transcript for an agent execution.
 */
export function createTranscript(
	agentType: string,
	prompt: string,
	systemPrompt: string,
	model: string,
	metadata?: Record<string, unknown>,
): AgentTranscript {
	const now = Date.now();
	return {
		id: randomUUID(),
		agentType,
		startedAt: now,
		updatedAt: now,
		originalPrompt: prompt,
		systemPrompt,
		model,
		messages: [],
		completed: false,
		metadata,
	};
}

/**
 * Update a transcript with new messages.
 */
export function updateTranscript(
	transcript: AgentTranscript,
	messages: AppMessage[],
): AgentTranscript {
	return {
		...transcript,
		messages,
		updatedAt: Date.now(),
	};
}

/**
 * Mark a transcript as completed.
 */
export function completeTranscript(
	transcript: AgentTranscript,
	result: string,
): AgentTranscript {
	return {
		...transcript,
		completed: true,
		result,
		updatedAt: Date.now(),
	};
}

/**
 * Mark a transcript as failed.
 */
export function failTranscript(
	transcript: AgentTranscript,
	error: string,
): AgentTranscript {
	return {
		...transcript,
		completed: true,
		error,
		updatedAt: Date.now(),
	};
}

/**
 * Extract a summary from a transcript for resumption context.
 */
export function getTranscriptSummary(transcript: AgentTranscript): string {
	const lines: string[] = [];

	lines.push(`## Previous ${transcript.agentType} Agent Session`);
	lines.push(`Started: ${new Date(transcript.startedAt).toISOString()}`);
	lines.push(`Original Task: ${transcript.originalPrompt}`);
	lines.push("");

	if (transcript.completed && transcript.result) {
		lines.push("### Previous Result:");
		lines.push(transcript.result);
		lines.push("");
	}

	// Add key messages (assistant responses, not tool results)
	const keyMessages = transcript.messages.filter(
		(m) => m.role === "assistant" || m.role === "user",
	);

	if (keyMessages.length > 0) {
		lines.push("### Conversation History:");
		for (const msg of keyMessages.slice(-10)) {
			// Last 10 messages
			if (msg.role === "user" && typeof msg.content === "string") {
				lines.push(
					`**User:** ${msg.content.slice(0, 500)}${msg.content.length > 500 ? "..." : ""}`,
				);
			} else if (msg.role === "assistant") {
				const text = msg.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");
				if (text) {
					lines.push(
						`**Assistant:** ${text.slice(0, 500)}${text.length > 500 ? "..." : ""}`,
					);
				}
			}
		}
	}

	return lines.join("\n");
}

/**
 * Build a resume prompt from a transcript.
 */
export function buildResumePrompt(
	transcript: AgentTranscript,
	newPrompt: string,
): string {
	const summary = getTranscriptSummary(transcript);

	return `${summary}

---

## Continuation Request

${newPrompt}

Please continue from where the previous session left off, building on the previous analysis and context.`;
}

// Default store instance
let defaultStore: TranscriptStore | null = null;

/**
 * Get the default transcript store.
 */
export function getDefaultTranscriptStore(): TranscriptStore {
	if (!defaultStore) {
		defaultStore = new FileTranscriptStore();
	}
	return defaultStore;
}

/**
 * Set the default transcript store.
 */
export function setDefaultTranscriptStore(store: TranscriptStore): void {
	defaultStore = store;
}
