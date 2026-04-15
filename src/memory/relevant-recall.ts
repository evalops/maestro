import { getDurableMemoryBackend } from "./backend.js";
import { searchMemories } from "./store.js";
import { getMemoryProjectScope } from "./team-memory.js";
import type { MemoryEntry, MemorySearchResult } from "./types.js";

const MIN_TERM_LENGTH = 4;
const MAX_TERMS = 6;
const MAX_RESULTS = 4;
const MAX_SEARCH_RESULTS_PER_TERM = 12;
const MAX_ENTRY_CHARS = 220;

const STOP_WORDS = new Set([
	"about",
	"after",
	"again",
	"along",
	"also",
	"because",
	"before",
	"being",
	"build",
	"change",
	"check",
	"create",
	"debug",
	"describe",
	"doing",
	"from",
	"have",
	"into",
	"just",
	"keep",
	"make",
	"need",
	"only",
	"please",
	"remove",
	"ship",
	"show",
	"some",
	"that",
	"them",
	"then",
	"this",
	"through",
	"update",
	"used",
	"using",
	"want",
	"what",
	"when",
	"with",
	"work",
	"would",
]);

interface ScoredMemoryCandidate {
	entry: MemoryEntry;
	score: number;
	matchedTerms: Set<string>;
}

function normalizeMemoryContent(content: string): string {
	return content
		.replace(/^#\s*Session Memory\b/gi, "")
		.replace(/\s+/g, " ")
		.trim();
}

function truncateMemoryContent(content: string, maxChars: number): string {
	if (content.length <= maxChars) {
		return content;
	}
	return `${content.slice(0, maxChars - 1).trimEnd()}…`;
}

function extractPromptTerms(prompt: string): string[] {
	const normalized = prompt.toLowerCase().trim();
	if (normalized.length < 12 || !/\s/.test(normalized)) {
		return [];
	}

	const terms: string[] = [];
	const seen = new Set<string>();
	for (const match of normalized.matchAll(/[a-z0-9][a-z0-9_-]*/g)) {
		const term = match[0];
		if (
			term.length < MIN_TERM_LENGTH ||
			STOP_WORDS.has(term) ||
			seen.has(term)
		) {
			continue;
		}
		seen.add(term);
		terms.push(term);
		if (terms.length >= MAX_TERMS) {
			break;
		}
	}

	return terms;
}

function shouldSkipSessionMemory(
	entry: MemoryEntry,
	currentSessionId: string | undefined,
	currentProjectId: string | undefined,
): boolean {
	if (
		currentProjectId &&
		entry.projectId &&
		entry.projectId !== currentProjectId
	) {
		return true;
	}
	return (
		entry.topic === "session-memory" && entry.sessionId !== currentSessionId
	);
}

function getEntryBoost(
	entry: MemoryEntry,
	result: MemorySearchResult,
	currentSessionId: string | undefined,
	currentProjectId: string | undefined,
): number {
	let boost = 0;
	if (currentSessionId && entry.sessionId === currentSessionId) {
		boost += 8;
	}
	if (currentProjectId && entry.projectId === currentProjectId) {
		boost += 6;
	}
	if (
		currentSessionId &&
		entry.topic === "session-memory" &&
		entry.sessionId === currentSessionId
	) {
		boost += 3;
	}
	if (result.matchedOn === "topic") {
		boost += 4;
	} else if (result.matchedOn === "tag") {
		boost += 2;
	}
	return boost;
}

function collectRelevantMemories(
	prompt: string,
	currentSessionId?: string,
	currentProjectId?: string,
	options?: {
		includeDurableLocalEntries?: boolean;
	},
): ScoredMemoryCandidate[] {
	const terms = extractPromptTerms(prompt);
	if (terms.length === 0) {
		return [];
	}

	const candidates = new Map<string, ScoredMemoryCandidate>();
	for (const term of terms) {
		const results = searchMemories(term, {
			limit: MAX_SEARCH_RESULTS_PER_TERM,
		});
		for (const result of results) {
			if (
				options?.includeDurableLocalEntries === false &&
				result.entry.topic !== "session-memory"
			) {
				continue;
			}
			if (
				shouldSkipSessionMemory(
					result.entry,
					currentSessionId,
					currentProjectId,
				)
			) {
				continue;
			}

			const existing = candidates.get(result.entry.id);
			const boostedScore =
				result.score +
				getEntryBoost(result.entry, result, currentSessionId, currentProjectId);
			if (existing) {
				existing.score += boostedScore;
				existing.matchedTerms.add(term);
				continue;
			}

			candidates.set(result.entry.id, {
				entry: result.entry,
				score: boostedScore,
				matchedTerms: new Set([term]),
			});
		}
	}

	return [...candidates.values()]
		.map((candidate) => ({
			...candidate,
			score: candidate.score + candidate.matchedTerms.size * 2,
		}))
		.sort((left, right) => {
			if (right.score !== left.score) {
				return right.score - left.score;
			}
			return right.entry.updatedAt - left.entry.updatedAt;
		})
		.slice(0, MAX_RESULTS);
}

function collectMatchedTerms(entry: MemoryEntry, terms: string[]): Set<string> {
	const haystack = [entry.topic, entry.content, ...(entry.tags ?? [])]
		.join(" ")
		.toLowerCase();
	return new Set(terms.filter((term) => haystack.includes(term)));
}

async function collectRemoteRelevantMemories(
	prompt: string,
	options?: {
		cwd?: string;
		currentProjectId?: string;
		currentProjectName?: string;
	},
): Promise<ScoredMemoryCandidate[] | null> {
	const terms = extractPromptTerms(prompt);
	if (terms.length === 0) {
		return [];
	}

	const results = await getDurableMemoryBackend().recallDurableMemories(
		prompt,
		{
			cwd: options?.cwd,
			limit: MAX_RESULTS,
		},
	);
	if (results === null) {
		return null;
	}

	return results
		.map((result) => {
			const entry: MemoryEntry = {
				...result.entry,
				projectId: options?.currentProjectId ?? result.entry.projectId,
				projectName: options?.currentProjectName ?? result.entry.projectName,
			};
			const matchedTerms = collectMatchedTerms(entry, terms);
			return {
				entry,
				score: result.score * 10 + matchedTerms.size * 2 + 6,
				matchedTerms,
			};
		})
		.filter((candidate) => candidate.matchedTerms.size > 0)
		.sort((left, right) => {
			if (right.score !== left.score) {
				return right.score - left.score;
			}
			return right.entry.updatedAt - left.entry.updatedAt;
		})
		.slice(0, MAX_RESULTS);
}

function formatMemoryLabel(
	entry: MemoryEntry,
	currentSessionId: string | undefined,
	currentProjectId: string | undefined,
): string {
	if (currentSessionId && entry.sessionId === currentSessionId) {
		return `${entry.topic}; current session`;
	}
	if (currentProjectId && entry.projectId === currentProjectId) {
		return `${entry.topic}; current repo`;
	}
	if (entry.sessionId) {
		return `${entry.topic}; prior session`;
	}
	return entry.topic;
}

export function buildRelevantMemoryPromptAddition(
	prompt: string,
	options?: {
		sessionId?: string;
		cwd?: string;
	},
): string | null {
	const currentSessionId = options?.sessionId;
	const currentProjectId = options?.cwd
		? (getMemoryProjectScope(options.cwd)?.projectId ?? undefined)
		: undefined;
	const candidates = collectRelevantMemories(
		prompt,
		currentSessionId,
		currentProjectId,
	);
	if (candidates.length === 0) {
		return null;
	}

	const lines = [
		"Automatic memory recall:",
		"Use these prior memories only if they materially help with the current request.",
	];

	for (const candidate of candidates) {
		const normalizedContent = normalizeMemoryContent(candidate.entry.content);
		if (!normalizedContent) {
			continue;
		}
		lines.push(
			`- [${formatMemoryLabel(candidate.entry, currentSessionId, currentProjectId)}] ${truncateMemoryContent(normalizedContent, MAX_ENTRY_CHARS)}`,
		);
	}

	return lines.length > 2 ? lines.join("\n") : null;
}

export async function buildRelevantMemoryPromptAdditionAsync(
	prompt: string,
	options?: {
		sessionId?: string;
		cwd?: string;
	},
): Promise<string | null> {
	const currentSessionId = options?.sessionId;
	const currentProjectScope = options?.cwd
		? getMemoryProjectScope(options.cwd)
		: null;
	const currentProjectId = currentProjectScope?.projectId;
	const currentProjectName = currentProjectScope?.projectName;
	const remoteCandidates = await collectRemoteRelevantMemories(prompt, {
		cwd: options?.cwd,
		currentProjectId,
		currentProjectName,
	});
	const candidates = [
		...collectRelevantMemories(prompt, currentSessionId, currentProjectId, {
			includeDurableLocalEntries: remoteCandidates === null,
		}),
		...(remoteCandidates ?? []),
	]
		.sort((left, right) => {
			if (right.score !== left.score) {
				return right.score - left.score;
			}
			return right.entry.updatedAt - left.entry.updatedAt;
		})
		.slice(0, MAX_RESULTS);
	if (candidates.length === 0) {
		return null;
	}

	const lines = [
		"Automatic memory recall:",
		"Use these prior memories only if they materially help with the current request.",
	];

	for (const candidate of candidates) {
		const normalizedContent = normalizeMemoryContent(candidate.entry.content);
		if (!normalizedContent) {
			continue;
		}
		lines.push(
			`- [${formatMemoryLabel(candidate.entry, currentSessionId, currentProjectId)}] ${truncateMemoryContent(normalizedContent, MAX_ENTRY_CHARS)}`,
		);
	}

	return lines.length > 2 ? lines.join("\n") : null;
}
