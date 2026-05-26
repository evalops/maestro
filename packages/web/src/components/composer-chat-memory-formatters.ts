import {
	formatMemoryRelativeTime,
	truncateMemoryText,
} from "@evalops/contracts";
import type {
	MemoryMutationResponse,
	MemoryRecentResponse,
	MemorySearchResponse,
	MemoryStatsResponse,
	MemoryTopicResponse,
	MemoryTopicsResponse,
	TeamMemoryMutationResponse,
	TeamMemoryStatusResponse,
} from "../services/api-client.js";

type MemoryEntry = {
	id: string;
	topic: string;
	content: string;
	updatedAt: number;
	tags: string[];
};

type MemoryTopicSummary = {
	name: string;
	entryCount: number;
	lastUpdated: number;
};

type MemorySearchResult = {
	entry: MemoryEntry;
	score: number;
	matchedOn: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function toStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string");
}

export function parseMemoryEntry(value: unknown): MemoryEntry | null {
	if (!isRecord(value)) return null;
	if (
		typeof value.id !== "string" ||
		typeof value.topic !== "string" ||
		typeof value.content !== "string" ||
		typeof value.updatedAt !== "number"
	) {
		return null;
	}
	return {
		id: value.id,
		topic: value.topic,
		content: value.content,
		updatedAt: value.updatedAt,
		tags: toStringArray(value.tags),
	};
}

function parseMemoryTopicSummary(value: unknown): MemoryTopicSummary | null {
	if (!isRecord(value)) return null;
	if (
		typeof value.name !== "string" ||
		typeof value.entryCount !== "number" ||
		typeof value.lastUpdated !== "number"
	) {
		return null;
	}
	return {
		name: value.name,
		entryCount: value.entryCount,
		lastUpdated: value.lastUpdated,
	};
}

function parseMemorySearchResult(value: unknown): MemorySearchResult | null {
	if (!isRecord(value)) return null;
	const entry = parseMemoryEntry(value.entry);
	if (
		!entry ||
		typeof value.score !== "number" ||
		typeof value.matchedOn !== "string"
	) {
		return null;
	}
	return {
		entry,
		score: value.score,
		matchedOn: value.matchedOn,
	};
}

export function formatMemoryTopicsBlock(result: MemoryTopicsResponse): string {
	const topics = Array.isArray(result.topics)
		? result.topics
				.map(parseMemoryTopicSummary)
				.filter((topic): topic is MemoryTopicSummary => topic !== null)
		: [];
	if (topics.length === 0) {
		return "No memories saved yet. Use /memory save <topic> <content> to add one.";
	}
	const lines = [`Memory Topics (${topics.length})`, ""];
	for (const topic of topics) {
		lines.push(
			`  ${topic.name} - ${topic.entryCount} ${topic.entryCount === 1 ? "entry" : "entries"} (${formatMemoryRelativeTime(topic.lastUpdated)})`,
		);
	}
	lines.push("", "Use /memory list <topic> to see entries");
	return lines.join("\n");
}

export function formatMemoryTopicEntriesBlock(
	topic: string,
	result: MemoryTopicResponse,
): string {
	const memories = Array.isArray(result.memories)
		? result.memories
				.map(parseMemoryEntry)
				.filter((entry): entry is MemoryEntry => entry !== null)
		: [];
	if (memories.length === 0) {
		return `No memories found for topic "${topic}"`;
	}
	const lines = [`Memories in "${topic}" (${memories.length})`, ""];
	for (const entry of memories.slice(0, 20)) {
		const tags = entry.tags.length ? ` [${entry.tags.join(", ")}]` : "";
		lines.push(`  • ${truncateMemoryText(entry.content, 70)}${tags}`);
		lines.push(
			`    ${entry.id} • ${formatMemoryRelativeTime(entry.updatedAt)}`,
		);
	}
	if (memories.length > 20) {
		lines.push(`  ... and ${memories.length - 20} more`);
	}
	return lines.join("\n");
}

export function formatMemorySearchResultsBlock(
	query: string,
	result: MemorySearchResponse,
): string {
	const results = Array.isArray(result.results)
		? result.results
				.map(parseMemorySearchResult)
				.filter((entry): entry is MemorySearchResult => entry !== null)
		: [];
	if (results.length === 0) {
		return `No memories found for "${query}"`;
	}
	const lines = [`Search Results for "${query}" (${results.length} found)`, ""];
	for (let index = 0; index < results.length; index += 1) {
		const resultEntry = results[index];
		if (!resultEntry) continue;
		lines.push(
			`${index + 1}. [${resultEntry.entry.topic}] ${truncateMemoryText(resultEntry.entry.content, 60)} [${resultEntry.score.toFixed(1)}] (${resultEntry.matchedOn})`,
		);
		lines.push(
			`   ID: ${resultEntry.entry.id} • ${formatMemoryRelativeTime(resultEntry.entry.updatedAt)}`,
		);
	}
	return lines.join("\n");
}

export function formatRecentMemoriesBlock(
	result: MemoryRecentResponse,
): string {
	const memories = Array.isArray(result.memories)
		? result.memories
				.map(parseMemoryEntry)
				.filter((entry): entry is MemoryEntry => entry !== null)
		: [];
	if (memories.length === 0) {
		return "No recent memories found.";
	}
	const lines = [`Recent Memories (${memories.length})`, ""];
	for (const entry of memories) {
		lines.push(`  [${entry.topic}] ${truncateMemoryText(entry.content, 70)}`);
		lines.push(
			`    ${entry.id} • ${formatMemoryRelativeTime(entry.updatedAt)}`,
		);
	}
	return lines.join("\n");
}

export function formatMemoryStatsBlock(result: MemoryStatsResponse): string {
	const stats = result.stats;
	const lines = ["Memory Statistics", ""];
	lines.push(`  Total entries: ${stats.totalEntries}`);
	lines.push(`  Topics: ${stats.topics}`);
	if (typeof stats.oldestEntry === "number") {
		lines.push(`  Oldest: ${formatMemoryRelativeTime(stats.oldestEntry)}`);
	}
	if (typeof stats.newestEntry === "number") {
		lines.push(`  Newest: ${formatMemoryRelativeTime(stats.newestEntry)}`);
	}
	return lines.join("\n");
}

export function formatTeamMemoryStatusBlock(
	result: TeamMemoryStatusResponse,
): string {
	if (!result.available || !result.status) {
		return "Team memory is only available inside a git repository.";
	}

	const { status } = result;
	const lines = [
		"Team Memory",
		"",
		`  Repo: ${status.projectName}`,
		`  Path: ${status.directory}`,
		`  Entrypoint: ${status.entrypoint}`,
		`  Status: ${status.exists ? "initialized" : "not initialized"}`,
		`  Files: ${status.fileCount}`,
	];

	if (status.files.length > 0) {
		lines.push("", "Files");
		for (const relativePath of status.files.slice(0, 12)) {
			lines.push(`  • ${relativePath}`);
		}
		if (status.files.length > 12) {
			lines.push(`  ... and ${status.files.length - 12} more`);
		}
	} else {
		lines.push("", "Run /memory team init to create MEMORY.md.");
	}

	return lines.join("\n");
}

export function formatMemoryMutationMessage(
	result: MemoryMutationResponse | TeamMemoryMutationResponse,
	fallback: string,
): string {
	return typeof result.message === "string" && result.message.length > 0
		? result.message
		: fallback;
}
