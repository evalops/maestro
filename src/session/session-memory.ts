import { existsSync, statSync } from "node:fs";
import { type MemoryEntry, upsertScopedMemory } from "../memory/index.js";
import { createLogger } from "../utils/logger.js";
import {
	buildSessionFileInfo,
	extractTextFromContent,
	safeReadSessionEntries,
} from "./session-context.js";
import type { SessionEntry } from "./types.js";

const logger = createLogger("session-memory");

export const SESSION_MEMORY_TOPIC = "session-memory";

function normalizeLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function collectSummaryHistory(entries: SessionEntry[], limit = 8): string[] {
	const summaries = entries
		.filter(
			(entry): entry is Extract<SessionEntry, { type: "session_meta" }> =>
				entry.type === "session_meta" &&
				typeof entry.summary === "string" &&
				entry.summary.trim().length > 0,
		)
		.map((entry) => normalizeLine(entry.summary ?? ""));

	const unique: string[] = [];
	for (let index = summaries.length - 1; index >= 0; index -= 1) {
		const summary = summaries[index];
		if (!summary || unique.includes(summary)) {
			continue;
		}
		unique.unshift(summary);
		if (unique.length >= limit) {
			break;
		}
	}
	return unique;
}

function collectRecentUserContext(
	entries: SessionEntry[],
	limit = 4,
): string[] {
	const lines: string[] = [];
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "message" || entry.message.role !== "user") {
			continue;
		}
		const text = normalizeLine(extractTextFromContent(entry.message.content));
		if (!text || lines.includes(text)) {
			continue;
		}
		lines.unshift(text);
		if (lines.length >= limit) {
			break;
		}
	}
	return lines;
}

export function buildSessionMemoryContent(sessionPath: string): {
	content: string;
	sessionId: string;
	memoryExtractionHash?: string;
	assistantTurnCount: number;
} | null {
	if (!existsSync(sessionPath)) {
		return null;
	}

	const stats = statSync(sessionPath);
	const entries = safeReadSessionEntries(sessionPath, (error) => {
		logger.warn("Failed to read session while building session memory", {
			sessionPath,
			error: error instanceof Error ? error.message : String(error),
		});
	});
	const info = buildSessionFileInfo(entries, stats);
	if (!info?.id || info.id === "unknown") {
		return null;
	}

	const currentState =
		info.resumeSummary?.trim() ||
		info.summary?.trim() ||
		"Session is active, but no runtime summary has been saved yet.";
	const title =
		info.title?.trim() ||
		info.summary?.trim() ||
		info.subject?.trim() ||
		info.id;
	const task =
		info.firstMessage.trim() ||
		info.subject?.trim() ||
		"No explicit task has been captured for this session yet.";
	const worklog = collectSummaryHistory(entries);
	const recentUserContext = collectRecentUserContext(entries);

	const lines = [
		"# Session Memory",
		"",
		`- Session: ${title}`,
		`- Session ID: ${info.id}`,
		`- Created: ${info.created.toISOString()}`,
		`- Updated: ${stats.mtime.toISOString()}`,
		`- Messages: ${info.messageCount}`,
	];

	if (info.tags?.length) {
		lines.push(`- Tags: ${info.tags.join(", ")}`);
	}

	lines.push("", "## Current State", currentState, "", "## Task", task);

	if (recentUserContext.length > 0) {
		lines.push(
			"",
			"## Recent User Context",
			...recentUserContext.map((line) => `- ${line}`),
		);
	}

	if (worklog.length > 0) {
		lines.push("", "## Worklog", ...worklog.map((line) => `- ${line}`));
	}

	return {
		content: lines.join("\n").trim(),
		sessionId: info.id,
		memoryExtractionHash: info.memoryExtractionHash,
		assistantTurnCount: info.messages.filter(
			(message) => message.role === "assistant",
		).length,
	};
}

export function syncSessionMemory(sessionPath: string): MemoryEntry | null {
	const built = buildSessionMemoryContent(sessionPath);
	if (!built) {
		return null;
	}

	return upsertScopedMemory(SESSION_MEMORY_TOPIC, built.content, {
		sessionId: built.sessionId,
		tags: ["session", "summary"],
	});
}
