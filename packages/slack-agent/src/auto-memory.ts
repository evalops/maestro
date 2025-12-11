/**
 * Auto Memory - Automatically extract and persist key facts from conversations
 *
 * After each conversation, extracts:
 * - Decisions made
 * - Preferences learned
 * - Files modified
 * - Problems solved
 * - Key commands/patterns discovered
 *
 * Appends to channel MEMORY.md without requiring explicit user request.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ConversationFacts {
	/** Files that were created or modified */
	filesModified: string[];
	/** Commands that were run successfully */
	commandsRun: string[];
	/** Problems that were solved */
	problemsSolved: string[];
	/** User preferences discovered */
	preferences: string[];
	/** Decisions made */
	decisions: string[];
	/** Key topics discussed */
	topics: string[];
}

export interface MemoryUpdate {
	/** When this update was created */
	timestamp: string;
	/** Summary of the conversation */
	summary: string;
	/** Extracted facts */
	facts: ConversationFacts;
}

/**
 * Extract facts from a conversation based on tool calls and messages
 */
export function extractFacts(
	toolCalls: Array<{
		name: string;
		args: Record<string, unknown>;
		result?: string;
		success: boolean;
	}>,
	messages: Array<{
		role: "user" | "assistant";
		text: string;
	}>,
): ConversationFacts {
	const facts: ConversationFacts = {
		filesModified: [],
		commandsRun: [],
		problemsSolved: [],
		preferences: [],
		decisions: [],
		topics: [],
	};

	// Extract files modified from write/edit tool calls
	for (const call of toolCalls) {
		if (!call.success) continue;

		if (call.name === "write" || call.name === "edit") {
			const path = call.args.path as string;
			if (path && !facts.filesModified.includes(path)) {
				facts.filesModified.push(path);
			}
		}

		if (call.name === "bash") {
			const command = call.args.command as string;
			if (command) {
				// Extract meaningful commands (not just echo or cd)
				const cmd = command.trim().split(/\s+/)[0];
				if (
					cmd &&
					!["echo", "cd", "pwd", "ls", "cat"].includes(cmd) &&
					command.length < 100
				) {
					// Store abbreviated version
					const abbreviated =
						command.length > 60 ? `${command.substring(0, 60)}...` : command;
					if (!facts.commandsRun.includes(abbreviated)) {
						facts.commandsRun.push(abbreviated);
					}
				}
			}
		}
	}

	// Extract topics and patterns from messages
	const userMessages = messages
		.filter((m) => m.role === "user")
		.map((m) => m.text);
	const assistantMessages = messages
		.filter((m) => m.role === "assistant")
		.map((m) => m.text);

	// Look for problem-solving patterns
	for (const msg of assistantMessages) {
		const lower = msg.toLowerCase();

		// Detect problem solved
		if (
			lower.includes("fixed") ||
			lower.includes("resolved") ||
			lower.includes("solved")
		) {
			// Try to extract what was fixed
			const match = msg.match(
				/(?:fixed|resolved|solved)\s+(?:the\s+)?(.{10,60}?)(?:\.|!|$)/i,
			);
			if (match?.[1]) {
				const problem = match[1].trim();
				if (!facts.problemsSolved.includes(problem)) {
					facts.problemsSolved.push(problem);
				}
			}
		}
	}

	// Look for user preferences
	for (const msg of userMessages) {
		const lower = msg.toLowerCase();

		// Detect preference expressions
		if (
			lower.includes("i prefer") ||
			lower.includes("i like") ||
			lower.includes("always use") ||
			lower.includes("don't use") ||
			lower.includes("never use")
		) {
			// Extract the preference
			const match = msg.match(
				/(?:i prefer|i like|always use|don't use|never use)\s+(.{5,50}?)(?:\.|!|,|$)/i,
			);
			if (match?.[1]) {
				const pref = match[1].trim();
				if (!facts.preferences.includes(pref)) {
					facts.preferences.push(pref);
				}
			}
		}
	}

	// Look for decisions
	for (const msg of assistantMessages) {
		const lower = msg.toLowerCase();

		if (
			lower.includes("decided to") ||
			lower.includes("we'll use") ||
			lower.includes("going with") ||
			lower.includes("chosen to")
		) {
			const match = msg.match(
				/(?:decided to|we'll use|going with|chosen to)\s+(.{5,60}?)(?:\.|!|,|$)/i,
			);
			if (match?.[1]) {
				const decision = match[1].trim();
				if (!facts.decisions.includes(decision)) {
					facts.decisions.push(decision);
				}
			}
		}
	}

	// Extract main topics from user questions
	for (const msg of userMessages) {
		// Look for key technical terms
		const techTerms = msg.match(
			/\b(api|database|auth|deploy|test|build|config|error|bug|feature|refactor|performance|security)\b/gi,
		);
		if (techTerms) {
			for (const term of techTerms) {
				const lower = term.toLowerCase();
				if (!facts.topics.includes(lower)) {
					facts.topics.push(lower);
				}
			}
		}
	}

	// Limit arrays to reasonable sizes
	facts.filesModified = facts.filesModified.slice(0, 10);
	facts.commandsRun = facts.commandsRun.slice(0, 5);
	facts.problemsSolved = facts.problemsSolved.slice(0, 5);
	facts.preferences = facts.preferences.slice(0, 5);
	facts.decisions = facts.decisions.slice(0, 5);
	facts.topics = facts.topics.slice(0, 10);

	return facts;
}

/**
 * Check if facts are worth persisting (non-trivial)
 */
export function hasSignificantFacts(facts: ConversationFacts): boolean {
	return (
		facts.filesModified.length > 0 ||
		facts.problemsSolved.length > 0 ||
		facts.preferences.length > 0 ||
		facts.decisions.length > 0
	);
}

/**
 * Format facts as markdown for MEMORY.md
 */
export function formatMemoryUpdate(update: MemoryUpdate): string {
	const lines: string[] = [];

	// Header with timestamp
	const date = update.timestamp.substring(0, 10);
	lines.push(`\n### ${date}\n`);

	if (update.summary) {
		lines.push(update.summary);
		lines.push("");
	}

	const { facts } = update;

	if (facts.filesModified.length > 0) {
		lines.push(`**Files modified:** ${facts.filesModified.join(", ")}`);
	}

	if (facts.problemsSolved.length > 0) {
		lines.push(`**Solved:** ${facts.problemsSolved.join("; ")}`);
	}

	if (facts.decisions.length > 0) {
		lines.push(`**Decisions:** ${facts.decisions.join("; ")}`);
	}

	if (facts.preferences.length > 0) {
		lines.push(`**Preferences:** ${facts.preferences.join("; ")}`);
	}

	if (facts.commandsRun.length > 0) {
		lines.push(`**Commands:** \`${facts.commandsRun.join("`, `")}\``);
	}

	return lines.join("\n");
}

/**
 * Append memory update to channel MEMORY.md
 */
export function appendToMemory(
	channelDir: string,
	update: MemoryUpdate,
): boolean {
	if (!hasSignificantFacts(update.facts)) {
		return false;
	}

	const memoryPath = join(channelDir, "MEMORY.md");
	const formatted = formatMemoryUpdate(update);

	try {
		let content = "";
		if (existsSync(memoryPath)) {
			content = readFileSync(memoryPath, "utf-8");
		} else {
			// Create initial memory file
			content =
				"# Channel Memory\n\nAutomatically captured context from conversations.\n";
		}

		// Check if we already have an entry for today to avoid duplicates
		const today = update.timestamp.substring(0, 10);
		if (content.includes(`### ${today}`)) {
			// Already have an entry for today, skip
			return false;
		}

		// Append the update
		content = `${content.trimEnd()}\n${formatted}\n`;
		writeFileSync(memoryPath, content);
		return true;
	} catch {
		return false;
	}
}

/**
 * Create a memory update from conversation data
 */
export function createMemoryUpdate(
	toolCalls: Array<{
		name: string;
		args: Record<string, unknown>;
		result?: string;
		success: boolean;
	}>,
	messages: Array<{
		role: "user" | "assistant";
		text: string;
	}>,
): MemoryUpdate {
	const facts = extractFacts(toolCalls, messages);

	// Generate a brief summary
	let summary = "";
	if (facts.problemsSolved.length > 0) {
		summary = `Fixed: ${facts.problemsSolved[0]}`;
	} else if (facts.filesModified.length > 0) {
		summary = `Worked on ${facts.filesModified.length} file(s)`;
	} else if (facts.topics.length > 0) {
		summary = `Discussed: ${facts.topics.join(", ")}`;
	}

	return {
		timestamp: new Date().toISOString(),
		summary,
		facts,
	};
}
