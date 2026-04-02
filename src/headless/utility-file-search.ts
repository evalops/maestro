import { basename, resolve } from "node:path";
import { getWorkspaceFiles } from "../utils/workspace-files.js";

export interface HeadlessUtilityFileSearchRequest {
	query: string;
	cwd?: string;
	limit?: number;
}

export interface HeadlessUtilityFileSearchMatch {
	path: string;
	score: number;
}

export interface HeadlessUtilityFileSearchResult {
	cwd: string;
	query: string;
	results: HeadlessUtilityFileSearchMatch[];
	truncated: boolean;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const SEARCH_SAMPLE_MULTIPLIER = 40;
const MIN_SEARCH_SAMPLE = 1000;

function subsequenceScore(haystack: string, needle: string): number {
	let searchIndex = 0;
	let score = 0;

	for (const char of needle) {
		const matchIndex = haystack.indexOf(char, searchIndex);
		if (matchIndex === -1) {
			return 0;
		}
		score += 12 - Math.min(10, matchIndex - searchIndex);
		searchIndex = matchIndex + 1;
	}

	return Math.max(score, 1);
}

function scorePathMatch(path: string, normalizedQuery: string): number {
	const normalizedPath = path.toLowerCase();
	const normalizedBase = basename(path).toLowerCase();

	if (normalizedBase === normalizedQuery) {
		return 10_000 - path.length;
	}
	if (normalizedPath === normalizedQuery) {
		return 9_500 - path.length;
	}
	if (normalizedBase.startsWith(normalizedQuery)) {
		return 8_000 - path.length;
	}
	const baseIndex = normalizedBase.indexOf(normalizedQuery);
	if (baseIndex !== -1) {
		return 7_000 - baseIndex * 10 - path.length;
	}
	const pathIndex = normalizedPath.indexOf(normalizedQuery);
	if (pathIndex !== -1) {
		return 6_000 - pathIndex * 10 - path.length;
	}

	const tokens = normalizedQuery
		.split(/\s+/)
		.map((token) => token.trim())
		.filter(Boolean);
	if (
		tokens.length > 1 &&
		tokens.every(
			(token) =>
				normalizedBase.includes(token) || normalizedPath.includes(token),
		)
	) {
		return 5_000 - path.length;
	}

	const subsequence = subsequenceScore(normalizedBase, normalizedQuery);
	if (subsequence > 0) {
		return 3_000 + subsequence - path.length;
	}

	const pathSubsequence = subsequenceScore(normalizedPath, normalizedQuery);
	if (pathSubsequence > 0) {
		return 2_000 + pathSubsequence - path.length;
	}

	return 0;
}

export function searchWorkspaceFiles(
	request: HeadlessUtilityFileSearchRequest,
): HeadlessUtilityFileSearchResult {
	const cwd = resolve(request.cwd ?? process.cwd());
	const query = request.query.trim();
	const limit = Math.max(
		1,
		Math.min(request.limit ?? DEFAULT_LIMIT, MAX_LIMIT),
	);

	if (!query) {
		return {
			cwd,
			query,
			results: [],
			truncated: false,
		};
	}

	const sampleSize = Math.max(
		limit * SEARCH_SAMPLE_MULTIPLIER,
		MIN_SEARCH_SAMPLE,
	);
	const files = getWorkspaceFiles(sampleSize, cwd);
	const normalizedQuery = query.toLowerCase();

	const scored = files
		.map((path) => ({
			path,
			score: scorePathMatch(path, normalizedQuery),
		}))
		.filter((match) => match.score > 0)
		.sort((left, right) => {
			if (right.score !== left.score) {
				return right.score - left.score;
			}
			if (left.path.length !== right.path.length) {
				return left.path.length - right.path.length;
			}
			return left.path.localeCompare(right.path);
		});

	return {
		cwd,
		query,
		results: scored.slice(0, limit),
		truncated: scored.length > limit,
	};
}
