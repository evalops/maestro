/**
 * Context Summarizer - Compress older conversation turns into summaries
 *
 * Instead of sending all 50 turns verbatim, we:
 * 1. Keep recent turns (last 10) verbatim for immediate context
 * 2. Summarize older turns into a compact summary
 * 3. Cache summaries to avoid re-processing
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ConversationTurn {
	date: string;
	user: string;
	text: string;
	isBot: boolean;
	attachments?: string[];
	threadReplies?: Array<{
		date: string;
		user: string;
		text: string;
	}>;
}

export interface ContextSummary {
	/** Hash of the messages that were summarized */
	hash: string;
	/** The summary text */
	summary: string;
	/** Number of turns summarized */
	turnCount: number;
	/** When this summary was created */
	createdAt: string;
}

export interface SummarizedContext {
	/** Summary of older turns (if any) */
	summary?: string;
	/** Number of turns that were summarized */
	summarizedTurnCount: number;
	/** Recent turns kept verbatim */
	recentTurns: ConversationTurn[];
}

/**
 * Configuration for context summarization
 */
export interface SummarizerConfig {
	/** Number of recent turns to keep verbatim (default: 10) */
	recentTurnCount: number;
	/** Minimum turns before summarization kicks in (default: 15) */
	minTurnsForSummary: number;
	/** Maximum characters for the summary (default: 2000) */
	maxSummaryChars: number;
}

const DEFAULT_CONFIG: SummarizerConfig = {
	recentTurnCount: 10,
	minTurnsForSummary: 15,
	maxSummaryChars: 2000,
};

/**
 * Generate a hash for a set of turns to detect if we need to re-summarize
 */
function hashTurns(turns: ConversationTurn[]): string {
	const content = turns.map((t) => `${t.date}|${t.user}|${t.text}`).join("\n");
	return createHash("sha256").update(content).digest("hex").substring(0, 16);
}

/**
 * Load cached summary from disk
 */
function loadCachedSummary(channelDir: string): ContextSummary | null {
	const summaryPath = join(channelDir, "context_summary.json");
	if (!existsSync(summaryPath)) {
		return null;
	}

	try {
		const content = readFileSync(summaryPath, "utf-8");
		return JSON.parse(content);
	} catch {
		return null;
	}
}

/**
 * Save summary to disk cache
 */
function saveCachedSummary(channelDir: string, summary: ContextSummary): void {
	const summaryPath = join(channelDir, "context_summary.json");
	try {
		writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
	} catch {
		// Ignore write errors
	}
}

/**
 * Generate a summary of conversation turns without using an LLM.
 * Uses heuristics to extract key information.
 */
function generateLocalSummary(
	turns: ConversationTurn[],
	maxChars: number,
): string {
	if (turns.length === 0) {
		return "";
	}

	const topics: string[] = [];
	const actions: string[] = [];
	const files: Set<string> = new Set();
	const users: Set<string> = new Set();

	for (const turn of turns) {
		users.add(turn.user);

		// Extract file mentions
		const fileMatches = turn.text.match(
			/[\w/.-]+\.(ts|js|py|go|rs|md|json|yaml|yml|sh|css|html|tsx|jsx)/gi,
		);
		if (fileMatches) {
			for (const f of fileMatches) {
				files.add(f);
			}
		}

		// Extract action keywords from bot responses
		if (turn.isBot) {
			const text = turn.text.toLowerCase();
			if (text.includes("created") || text.includes("wrote")) {
				actions.push("created files");
			}
			if (text.includes("fixed") || text.includes("resolved")) {
				actions.push("fixed issues");
			}
			if (
				text.includes("updated") ||
				text.includes("modified") ||
				text.includes("edited")
			) {
				actions.push("updated code");
			}
			if (text.includes("installed") || text.includes("added dependency")) {
				actions.push("installed dependencies");
			}
			if (
				text.includes("test") &&
				(text.includes("pass") || text.includes("success"))
			) {
				actions.push("ran tests");
			}
			if (text.includes("error") || text.includes("failed")) {
				actions.push("debugged errors");
			}
		} else {
			// Extract question topics from user messages
			const text = turn.text.toLowerCase();
			if (
				text.includes("how") ||
				text.includes("what") ||
				text.includes("why") ||
				text.includes("?")
			) {
				// Extract first noun phrase after question word
				const words = turn.text.split(/\s+/).slice(0, 10);
				if (words.length > 2) {
					topics.push(words.slice(0, 5).join(" "));
				}
			}
		}
	}

	// Build summary
	const parts: string[] = [];

	// Time range
	const firstDate = turns[0]!.date.substring(0, 10);
	const lastDate = turns[turns.length - 1]!.date.substring(0, 10);
	if (firstDate === lastDate) {
		parts.push(`Conversation on ${firstDate}`);
	} else {
		parts.push(`Conversation from ${firstDate} to ${lastDate}`);
	}

	// Participants
	const userList = Array.from(users).filter((u) => u && u !== "bot");
	if (userList.length > 0) {
		parts.push(`Participants: ${userList.join(", ")}`);
	}

	// Turn count
	parts.push(`${turns.length} messages exchanged`);

	// Actions taken (deduplicated)
	const uniqueActions = [...new Set(actions)];
	if (uniqueActions.length > 0) {
		parts.push(`Actions: ${uniqueActions.slice(0, 5).join(", ")}`);
	}

	// Files mentioned
	if (files.size > 0) {
		const fileList = Array.from(files).slice(0, 10);
		parts.push(`Files discussed: ${fileList.join(", ")}`);
	}

	// Topics (first few unique ones)
	const uniqueTopics = [...new Set(topics)].slice(0, 3);
	if (uniqueTopics.length > 0) {
		parts.push(`Topics: ${uniqueTopics.join("; ")}`);
	}

	let summary = `${parts.join(". ")}.`;

	// Truncate if too long
	if (summary.length > maxChars) {
		summary = `${summary.substring(0, maxChars - 3)}...`;
	}

	return summary;
}

/**
 * Prepare context with summarization of older turns
 */
export function summarizeContext(
	turns: ConversationTurn[],
	channelDir: string,
	config: Partial<SummarizerConfig> = {},
): SummarizedContext {
	const cfg = { ...DEFAULT_CONFIG, ...config };

	// Not enough turns to warrant summarization
	if (turns.length <= cfg.minTurnsForSummary) {
		return {
			summarizedTurnCount: 0,
			recentTurns: turns,
		};
	}

	// Split into older turns (to summarize) and recent turns (keep verbatim)
	const splitPoint = turns.length - cfg.recentTurnCount;
	const olderTurns = turns.slice(0, splitPoint);
	const recentTurns = turns.slice(splitPoint);

	// Check if we have a cached summary for these older turns
	const olderHash = hashTurns(olderTurns);
	const cached = loadCachedSummary(channelDir);

	if (cached && cached.hash === olderHash) {
		// Use cached summary
		return {
			summary: cached.summary,
			summarizedTurnCount: cached.turnCount,
			recentTurns,
		};
	}

	// Generate new summary
	const summary = generateLocalSummary(olderTurns, cfg.maxSummaryChars);

	// Cache it
	const newSummary: ContextSummary = {
		hash: olderHash,
		summary,
		turnCount: olderTurns.length,
		createdAt: new Date().toISOString(),
	};
	saveCachedSummary(channelDir, newSummary);

	return {
		summary,
		summarizedTurnCount: olderTurns.length,
		recentTurns,
	};
}

/**
 * Format summarized context for inclusion in system prompt
 */
export function formatSummarizedContext(context: SummarizedContext): string {
	const parts: string[] = [];

	if (context.summary && context.summarizedTurnCount > 0) {
		parts.push(
			`## Earlier Conversation Summary (${context.summarizedTurnCount} messages)`,
		);
		parts.push(context.summary);
		parts.push("");
		parts.push(`## Recent Messages (${context.recentTurns.length} messages)`);
	}

	// Format recent turns
	for (const turn of context.recentTurns) {
		const date = turn.date.substring(0, 19);
		const attachments = turn.attachments?.join(",") || "";
		parts.push(`${date}\t${turn.user}\t${turn.text}\t${attachments}`);

		// Include thread replies
		if (turn.threadReplies) {
			for (const reply of turn.threadReplies) {
				const replyDate = reply.date.substring(0, 19);
				parts.push(`${replyDate}\t  ↳ ${reply.user}\t${reply.text}\t`);
			}
		}
	}

	return parts.join("\n");
}
