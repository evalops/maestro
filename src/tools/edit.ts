/**
 * Edit Tool - Find-and-replace text editing with fuzzy matching fallback
 *
 * This module implements a robust text editing tool that performs exact string
 * replacement with intelligent fallback to approximate matching when exact matches
 * fail. The core design philosophy is "fail helpfully" - when the user's search
 * text doesn't match exactly (due to whitespace differences, typos, or outdated
 * content), we provide actionable suggestions pointing to the closest matches.
 *
 * ## Architecture Overview
 *
 * 1. **Exact Matching (Primary Path)**
 *    - Simple string indexOf search for O(n) performance
 *    - Handles single edit, multi-edit (sequential), and replace-all modes
 *    - Reports all match locations with line numbers for disambiguation
 *
 * 2. **Approximate Matching (Fallback Path)**
 *    - Triggered only when exact match fails
 *    - Uses two complementary strategies:
 *      a) Regex-based relaxed matching (whitespace normalization)
 *      b) Line-by-line Levenshtein similarity scoring
 *    - Results sorted by similarity score, filtered by threshold
 *
 * 3. **Similarity Scoring**
 *    - Levenshtein distance normalized to 0-1 similarity ratio
 *    - Dual thresholds: 50% for single candidates, 60% for multiple
 *    - Prevents noise while surfacing genuinely close matches
 *
 * ## Key Design Decisions
 *
 * - **Atomic writes**: Uses temp file + rename for crash safety
 * - **Multi-edit mode**: Applies edits sequentially for deterministic results
 * - **LSP integration**: Collects diagnostics after edits for immediate feedback
 * - **Sandbox support**: Operates through sandbox abstraction when available
 *
 * @module tools/edit
 */

import crypto from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { Type } from "@sinclair/typebox";
import { collectDiagnostics } from "../lsp/index.js";
import {
	requirePlanCheck,
	runValidatorsOnSuccess,
} from "../safety/safe-mode.js";
import type { ValidatorRunResult } from "../safety/safe-mode.js";
import { formatLspDiagnostics, generateDiffString } from "./diff-utils.js";
import { createTool, expandUserPath } from "./tool-dsl.js";

async function writeFileAtomically(
	filePath: string,
	contents: string,
): Promise<void> {
	const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
	await writeFile(tempPath, contents, "utf-8");
	try {
		await rename(tempPath, filePath);
	} catch (error) {
		await unlink(tempPath).catch(() => {});
		throw error;
	}
}

/** Diff support lives in diff-utils for reuse */

type LineEnding = "\n" | "\r\n" | "\r";

type NormalizedDocument = {
	original: string;
	normalized: string;
	bom: string;
	lineEnding: LineEnding;
};

function detectLineEnding(text: string): LineEnding {
	if (text.includes("\r\n")) return "\r\n";
	if (text.includes("\r")) return "\r";
	return "\n";
}

function normalizeDocument(content: string): NormalizedDocument {
	const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
	const withoutBom = bom ? content.slice(1) : content;
	const lineEnding = detectLineEnding(withoutBom);
	const normalized = withoutBom.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	return { original: content, normalized, bom, lineEnding };
}

function normalizeEditText(text: string | undefined): string | undefined {
	if (text === undefined) return undefined;
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreDocumentContent(
	normalized: string,
	document: NormalizedDocument,
): string {
	const restored =
		document.lineEnding === "\n"
			? normalized
			: normalized.replace(/\n/g, document.lineEnding);
	return `${document.bom}${restored}`;
}

const editOperationSchema = Type.Object({
	oldText: Type.String({
		description: "Exact text to find and replace",
		minLength: 1,
	}),
	newText: Type.Optional(
		Type.String({
			description: "Replacement text (omit or empty string to delete)",
			default: "",
		}),
	),
});

const editSchema = Type.Object({
	path: Type.String({
		description: "Path to the file to edit (relative or absolute)",
		minLength: 1,
	}),
	oldText: Type.Optional(
		Type.String({
			description: "Exact text to find and replace (must match exactly)",
			minLength: 1,
		}),
	),
	newText: Type.Optional(
		Type.String({
			description: "New text to replace the old text with",
			default: "",
		}),
	),
	edits: Type.Optional(
		Type.Array(editOperationSchema, {
			description:
				"Multiple edits to apply sequentially (alternative to oldText/newText)",
			minItems: 1,
			maxItems: 50,
		}),
	),
	replaceAll: Type.Optional(
		Type.Boolean({
			description:
				"Replace all occurrences (useful for variable renaming). Cannot be used with occurrence or edits.",
			default: false,
		}),
	),
	occurrence: Type.Optional(
		Type.Integer({
			description:
				"Which occurrence of the text to replace (1-based). Cannot be used with replaceAll or edits.",
			minimum: 1,
			default: 1,
		}),
	),
	dryRun: Type.Optional(
		Type.Boolean({
			description: "Preview the diff without writing changes",
			default: false,
		}),
	),
});

type EditToolDetails = {
	diff: string;
	editsApplied?: number;
	validators?: ValidatorRunResult[];
	mode?: "sandbox";
};

export const editTool = createTool<typeof editSchema, EditToolDetails>({
	name: "edit",
	label: "edit",
	description: `Edit files with find-and-replace. oldText must match exactly (whitespace, indentation, newlines).

Parameters:
- path: File path
- oldText/newText: Single edit (text to find and replacement)
- edits: Array of {oldText, newText} for multiple sequential edits (1-50)
- replaceAll: Replace all occurrences (default: false). For single edit only.
- occurrence: Which match (default: 1). For single edit only.
- dryRun: Preview only (default: false)

Use either oldText/newText OR edits array, not both.

Best practices:
- Read file first to verify exact formatting
- Include context (5-10 lines) for uniqueness
- Match indentation style (tabs vs spaces)
- Use dryRun for complex edits
- Use edits array for multiple related changes (atomic)

If "not found", read file to check actual content.`,
	schema: editSchema,
	async run(
		{
			path,
			oldText,
			newText,
			edits,
			replaceAll = false,
			occurrence = 1,
			dryRun = false,
		},
		{ signal, respond, sandbox },
	) {
		requirePlanCheck("edit");

		const absolutePath = resolvePath(expandUserPath(path));
		const throwIfAborted = () => {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}
		};

		// Validate mutually exclusive parameters
		const hasSingleEdit = oldText !== undefined;
		// newText with non-empty value alongside edits array is an error
		// (empty string is allowed as it's the default and harmless)
		const hasExplicitNewText = newText !== undefined && newText !== "";
		const hasMultiEdit = edits !== undefined && edits.length > 0;

		if ((hasSingleEdit || hasExplicitNewText) && hasMultiEdit) {
			throw new Error(
				"Cannot use both oldText/newText and edits array. Use one or the other.",
			);
		}

		if (!hasSingleEdit && !hasMultiEdit) {
			throw new Error("Must provide either oldText/newText or edits array.");
		}

		if (hasMultiEdit && (replaceAll || occurrence !== 1)) {
			throw new Error(
				"Cannot use replaceAll or occurrence with edits array. These options only apply to single edits.",
			);
		}

		if (replaceAll && occurrence !== 1) {
			throw new Error("Cannot use both replaceAll and occurrence.");
		}

		const normalizedOldText = normalizeEditText(oldText);
		const normalizedNewText = normalizeEditText(newText);
		const normalizedEdits = edits?.map((edit) => ({
			...edit,
			oldText: normalizeEditText(edit.oldText) ?? "",
			newText: normalizeEditText(edit.newText),
		}));

		// Helper to apply edits to content (shared between sandbox and normal mode)
		const applyEdits = (
			originalContent: string,
		): { newContent: string; replacementCount: number } => {
			if (hasMultiEdit && normalizedEdits) {
				let content = originalContent;
				let editsApplied = 0;
				for (const [index, edit] of normalizedEdits.entries()) {
					const matches = findExactMatches(content, edit.oldText);
					if (matches.length === 0) {
						const approx = findApproximateMatches(content, edit.oldText);
						const suggestion = approx.length
							? `\n\nPossible matches:\n${approx.slice(0, 3).map(formatMatchPreview).join("\n")}`
							: "";
						throw new Error(
							`Edit #${index + 1}: Could not find text after ${editsApplied} prior edit(s).${suggestion}`,
						);
					}
					if (matches.length > 1) {
						throw new Error(
							`Edit #${index + 1}: Found ${matches.length} matches for oldText. Provide more context. Matches at lines: ${matches.map((m) => m.line).join(", ")}`,
						);
					}
					const matchIndex = matches[0]?.index ?? 0;
					content =
						content.slice(0, matchIndex) +
						(edit.newText ?? "") +
						content.slice(matchIndex + edit.oldText.length);
					editsApplied++;
				}
				return { newContent: content, replacementCount: editsApplied };
			}
			// Single edit mode
			if (!normalizedOldText || normalizedOldText.length === 0) {
				throw new Error("oldText cannot be empty");
			}
			const exactMatches = findExactMatches(originalContent, normalizedOldText);
			if (exactMatches.length === 0) {
				const approx = findApproximateMatches(
					originalContent,
					normalizedOldText,
				);
				const suggestion = approx.length
					? `\n\nPossible matches:\n${approx.slice(0, 3).map(formatMatchPreview).join("\n")}`
					: `\n\nTip: double-check whitespace/newlines via /diff ${path}`;
				throw new Error(
					`Could not find the exact text in ${path}.${suggestion}`,
				);
			}
			if (replaceAll) {
				if (exactMatches.length > 10000) {
					throw new Error(
						`Too many replacements: ${exactMatches.length} (max 10000).`,
					);
				}
				return {
					newContent: originalContent.replaceAll(
						normalizedOldText,
						normalizedNewText ?? "",
					),
					replacementCount: exactMatches.length,
				};
			}
			if (occurrence > exactMatches.length) {
				throw new Error(
					`Only ${exactMatches.length} occurrence(s) found, but #${occurrence} requested.`,
				);
			}
			const targetMatch = exactMatches[occurrence - 1]!;
			const matchIndex = targetMatch.index ?? 0;
			return {
				newContent:
					originalContent.slice(0, matchIndex) +
					(normalizedNewText ?? "") +
					originalContent.slice(matchIndex + normalizedOldText.length),
				replacementCount: 1,
			};
		};

		// Use sandbox if available
		if (sandbox) {
			try {
				const exists = await sandbox.exists(path);
				if (!exists) {
					throw new Error(`File not found in sandbox: ${path}`);
				}
				const originalContent = await sandbox.readFile(path);
				const document = normalizeDocument(originalContent);
				const { newContent: normalizedNewContent, replacementCount } =
					applyEdits(document.normalized);
				const newContent = restoreDocumentContent(
					normalizedNewContent,
					document,
				);
				const diff = generateDiffString(originalContent, newContent);

				if (!dryRun) {
					await sandbox.writeFile(path, newContent);
				}

				return respond
					.text(
						dryRun
							? `[DRY RUN] Would apply ${replacementCount} edit(s) to ${path} in sandbox`
							: `Applied ${replacementCount} edit(s) to ${path} in sandbox`,
					)
					.detail({ diff, editsApplied: replacementCount, mode: "sandbox" });
			} catch (err) {
				if (err instanceof Error) throw err;
				throw new Error(String(err));
			}
		}

		try {
			await access(absolutePath, constants.R_OK | constants.W_OK);
		} catch {
			// Provide helpful hint
			let hint = "";
			if (path.includes("//")) {
				hint = " Hint: path contains double slashes.";
			}
			throw new Error(
				`File not found: ${path}.${hint} Use 'read' to verify the path exists.`,
			);
		}

		throwIfAborted();
		const originalContent = await readFile(absolutePath, "utf-8");
		throwIfAborted();
		const document = normalizeDocument(originalContent);
		const { newContent: normalizedNewContent, replacementCount } = applyEdits(
			document.normalized,
		);
		const newContent = restoreDocumentContent(normalizedNewContent, document);
		const diff = generateDiffString(originalContent, newContent);

		if (dryRun) {
			const modeDesc = hasMultiEdit
				? `${replacementCount} edit(s)`
				: replaceAll
					? "all occurrences"
					: `occurrence #${occurrence}`;
			return respond
				.text(`Dry run: preview for ${path} (${modeDesc}). No changes written.`)
				.detail({
					diff,
					editsApplied: hasMultiEdit ? replacementCount : undefined,
				});
		}

		await writeFileAtomically(absolutePath, newContent);
		let validatorSummaries: ValidatorRunResult[] | undefined;
		let linterOutput = "";
		try {
			const lspDiagnostics = await collectDiagnostics();
			const fileDiagnostics = lspDiagnostics[absolutePath] || [];
			if (fileDiagnostics.length > 0) {
				linterOutput = formatLspDiagnostics(path, fileDiagnostics);
			}
			validatorSummaries = await runValidatorsOnSuccess(
				[absolutePath],
				lspDiagnostics,
			);
		} catch (validatorError) {
			await writeFileAtomically(absolutePath, originalContent);
			throw validatorError;
		}

		throwIfAborted();

		const resultMessage = hasMultiEdit
			? `Successfully applied ${replacementCount} edit(s) to ${path}.`
			: replaceAll
				? `Successfully replaced all ${replacementCount} occurrence(s) in ${path}.`
				: `Successfully edited ${path}.`;

		return respond
			.text(linterOutput ? `${resultMessage}\n${linterOutput}` : resultMessage)
			.detail({
				diff,
				editsApplied: hasMultiEdit ? replacementCount : undefined,
				validators: validatorSummaries,
			});
	},
});

type MatchPreview = {
	line: number;
	snippet: string;
	index?: number;
	similarity?: number;
};

function findExactMatches(content: string, snippet: string): MatchPreview[] {
	const matches: MatchPreview[] = [];
	let index = content.indexOf(snippet);
	while (index !== -1) {
		matches.push({
			line: getLineNumber(content, index),
			snippet: getSnippet(content, index, snippet.length),
			index,
		});
		index = content.indexOf(snippet, index + snippet.length);
	}
	return matches;
}

/**
 * Levenshtein Distance Algorithm - Measures string similarity via edit operations
 *
 * Computes the minimum number of single-character edits (insertions, deletions,
 * or substitutions) required to transform string `a` into string `b`. This is
 * the classic dynamic programming solution, optimized for space efficiency.
 *
 * ## Algorithm Explanation
 *
 * The standard DP approach uses a 2D matrix where cell [i,j] represents the
 * edit distance between a[0..i-1] and b[0..j-1]. The recurrence relation:
 *
 *   dist[i][j] = min(
 *     dist[i-1][j] + 1,      // deletion: remove char from a
 *     dist[i][j-1] + 1,      // insertion: add char to a
 *     dist[i-1][j-1] + cost  // substitution: cost=0 if chars match, else 1
 *   )
 *
 * ## Space Optimization
 *
 * Since each row only depends on the previous row, we use two 1D arrays instead
 * of a full matrix. This reduces space complexity from O(m*n) to O(min(m,n)).
 *
 * - `prev`: the previous row of the DP matrix
 * - `curr`: the current row being computed
 * - After each outer loop iteration, we swap the arrays
 *
 * ## Complexity
 *
 * - Time: O(m * n) where m = len(a), n = len(b)
 * - Space: O(n) - only two arrays of length n+1
 *
 * ## Usage in Edit Tool
 *
 * This function powers the fuzzy matching fallback. When an exact match fails,
 * we compute Levenshtein distance between the search text and candidate regions
 * in the file, then convert to a similarity ratio (see `similarity()` below).
 *
 * @param a - First string to compare
 * @param b - Second string to compare
 * @returns The edit distance (0 = identical, higher = more different)
 */
function levenshtein(a: string, b: string): number {
	// Base cases: if either string is empty, distance is the length of the other
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;

	// Space-optimized DP: maintain only two rows instead of full matrix.
	// `prev` holds the distances computed for the previous character of `a`.
	// Initialize with distances from empty string: 0, 1, 2, ..., b.length
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	let curr = new Array<number>(b.length + 1);

	// Iterate through each character of string `a`
	for (let i = 1; i <= a.length; i++) {
		// Distance from a[0..i-1] to empty string is i (delete all chars)
		curr[0] = i;

		// Iterate through each character of string `b`
		for (let j = 1; j <= b.length; j++) {
			// Cost is 0 if characters match, 1 if they need substitution
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;

			// Take minimum of three possible operations:
			curr[j] = Math.min(
				prev[j]! + 1, // deletion: remove a[i-1], use distance for a[0..i-2] to b[0..j-1]
				curr[j - 1]! + 1, // insertion: insert b[j-1], use distance for a[0..i-1] to b[0..j-2]
				prev[j - 1]! + cost, // substitution: use distance for a[0..i-2] to b[0..j-2] + substitution cost
			);
		}
		// Swap rows: current row becomes previous for next iteration
		[prev, curr] = [curr, prev];
	}
	// After all iterations, `prev` contains the final row (due to swap)
	return prev[b.length]!;
}

/**
 * Similarity Ratio - Normalizes Levenshtein distance to a 0-1 scale
 *
 * Converts the raw edit distance into an intuitive percentage where:
 * - 1.0 = identical strings (0 edits needed)
 * - 0.0 = completely different (edit distance equals max string length)
 *
 * Formula: similarity = 1 - (edit_distance / max_length)
 *
 * This normalization is crucial because raw edit distance doesn't account
 * for string length. For example, an edit distance of 5 between two 100-char
 * strings (95% similar) is very different from distance 5 between two 6-char
 * strings (17% similar).
 *
 * @param a - First string to compare
 * @param b - Second string to compare
 * @returns Similarity ratio from 0 (completely different) to 1 (identical)
 */
function similarity(a: string, b: string): number {
	const maxLen = Math.max(a.length, b.length);
	// Two empty strings are identical
	if (maxLen === 0) return 1;
	// Normalize: 0 edits = 1.0 similarity, maxLen edits = 0.0 similarity
	return 1 - levenshtein(a, b) / maxLen;
}

/**
 * Similarity Thresholds for Approximate Matching
 *
 * These thresholds control which fuzzy matches are shown to the user. They're
 * intentionally different based on context to balance helpfulness vs noise.
 *
 * ## Threshold Strategy
 *
 * **Single Candidate (50%)**: When only one potential match is found, we're
 * lenient because showing something is better than nothing. Even a 50% match
 * might be the reformatted/moved code the user is looking for.
 *
 * **Multiple Candidates (60%)**: When several matches exist, we're stricter
 * to avoid overwhelming the user with noise. A higher threshold ensures only
 * genuinely relevant suggestions surface.
 *
 * ## Why These Values?
 *
 * - 50% catches significant changes (indentation, variable renames, added lines)
 *   while filtering out completely unrelated code
 * - 60% for multiple matches prevents showing 3+ mediocre suggestions that
 *   confuse more than they help
 * - Values chosen empirically from real-world edit failure scenarios
 */
const SINGLE_CANDIDATE_THRESHOLD = 0.5; // Accept single match if 50%+ similar
const MULTI_CANDIDATE_THRESHOLD = 0.6; // Need 60%+ to show when multiple matches

/**
 * Approximate Match Finder - Multi-strategy fuzzy search for similar text
 *
 * When exact matching fails, this function attempts to find regions in the file
 * that closely resemble the search snippet. It employs two complementary strategies
 * to maximize the chances of finding the right location even when the content
 * has changed.
 *
 * ## Strategy 1: Relaxed Regex Matching
 *
 * Creates a regex that normalizes whitespace (see `buildRelaxedRegex`), then
 * finds all matches in the content. This catches cases where:
 * - Indentation changed (tabs vs spaces, different indent levels)
 * - Extra blank lines were added/removed
 * - Line wrapping changed
 *
 * ## Strategy 2: Sliding Window Line Comparison
 *
 * For multi-line snippets, slides a window of the same size through the content
 * and computes Levenshtein similarity at each position. This catches cases where:
 * - Variables were renamed
 * - Minor code changes occurred (added parameters, changed values)
 * - Content was moved but not significantly altered
 *
 * ## Deduplication
 *
 * Both strategies may find the same region; we deduplicate by line number to
 * avoid showing duplicate suggestions.
 *
 * ## Result Limits
 *
 * - Maximum 10 candidates collected (performance guard)
 * - Maximum 5 shown to user (UI clarity)
 * - Dynamic threshold based on candidate count (see threshold constants above)
 *
 * @param content - The full file content to search in
 * @param snippet - The text the user is looking for
 * @returns Array of match previews sorted by similarity, filtered by threshold
 */
function findApproximateMatches(
	content: string,
	snippet: string,
): MatchPreview[] {
	// Strategy 1: Regex-based matching with whitespace normalization
	const relaxed = buildRelaxedRegex(snippet);
	const regexMatches: Array<MatchPreview & { similarity: number }> = [];

	if (relaxed) {
		let result: RegExpExecArray | null;
		// Limit to 10 matches to prevent performance issues in large files
		while (regexMatches.length < 10) {
			result = relaxed.exec(content);
			if (!result) break;
			const matchIndex = result.index;
			const matchText = result[0];
			// Score each regex match by actual similarity (regex may be too permissive)
			const sim = similarity(snippet.trim(), matchText.trim());
			regexMatches.push({
				line: getLineNumber(content, matchIndex),
				snippet: getSnippet(content, matchIndex, matchText.length),
				similarity: sim,
			});
		}
	}

	// Strategy 2: Sliding window comparison for multi-line snippets
	// This catches renamed variables and minor changes that regex misses
	const snippetLines = snippet.trim().split("\n");
	if (snippetLines.length > 1) {
		const contentLines = content.split("\n");
		// Slide a window of size |snippetLines| through the content
		for (let i = 0; i <= contentLines.length - snippetLines.length; i++) {
			const candidateLines = contentLines.slice(i, i + snippetLines.length);
			const candidate = candidateLines.join("\n");
			const sim = similarity(snippet.trim(), candidate.trim());
			// Only consider if above the minimum threshold
			if (sim >= SINGLE_CANDIDATE_THRESHOLD) {
				// Deduplicate: don't add if we already found this line via regex
				const lineNum = i + 1;
				if (!regexMatches.some((m) => m.line === lineNum)) {
					regexMatches.push({
						line: lineNum,
						// Show first 3 lines as preview to avoid overwhelming output
						snippet: candidateLines.slice(0, 3).join("\n").trim(),
						similarity: sim,
					});
				}
			}
			// Performance guard: stop after collecting 10 candidates
			if (regexMatches.length >= 10) break;
		}
	}

	// Sort all candidates by similarity (best matches first)
	regexMatches.sort((a, b) => b.similarity - a.similarity);

	// Apply dynamic threshold: stricter when many candidates exist
	// This prevents showing 5 mediocre matches when there's one good one
	const threshold =
		regexMatches.length === 1
			? SINGLE_CANDIDATE_THRESHOLD
			: MULTI_CANDIDATE_THRESHOLD;

	// Return top 5 matches above threshold, stripping internal similarity score
	return regexMatches
		.filter((m) => m.similarity >= threshold)
		.slice(0, 5)
		.map(({ line, snippet, similarity }) => ({ line, snippet, similarity }));
}

/**
 * Relaxed Regex Builder - Creates whitespace-normalized pattern for fuzzy matching
 *
 * Transforms a literal search string into a regex that matches the same content
 * with flexible whitespace. This is the first strategy in approximate matching.
 *
 * ## Transformation Steps
 *
 * 1. **Trim**: Remove leading/trailing whitespace (user likely copied extra)
 * 2. **Escape metacharacters**: Treat all regex special chars as literals
 *    - Characters escaped: . * + ? ^ $ { } ( ) | [ ] \
 * 3. **Normalize whitespace**: Replace all whitespace runs with `\s+`
 *    - Matches any combination of spaces, tabs, newlines
 *    - Makes indentation changes transparent
 *
 * ## Example Transformation
 *
 * Input:  "function foo(  a, b  ) {"
 * Regex:  "function\s+foo\(\s+a,\s+b\s+\)\s+\{"
 * Matches: "function foo(a, b) {" or "function  foo(  a,  b  )  {"
 *
 * ## Safety Guards
 *
 * - Empty input → null (avoid matching everything)
 * - Pattern > 500 chars → null (prevent ReDoS on very long snippets)
 * - Invalid regex → null (graceful fallback to line-by-line comparison)
 *
 * @param snippet - The text to convert into a relaxed regex
 * @returns Compiled regex with 'gi' flags, or null if construction fails
 */
function buildRelaxedRegex(snippet: string): RegExp | null {
	const trimmed = snippet.trim();
	// Empty pattern would match everything - not useful
	if (!trimmed) return null;

	// Step 1: Escape all regex metacharacters so they match literally
	// This prevents "user.name" from being interpreted as "user<any-char>name"
	const escaped = trimmed
		.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		// Step 2: Replace whitespace runs with flexible matcher
		// This makes the pattern match regardless of indentation style
		.replace(/\s+/g, "\\s+");

	// Guard against ReDoS: very long patterns can cause exponential backtracking
	if (escaped.length > 500) return null;

	try {
		// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
		// Flags: g = global (find all), i = case-insensitive (catches renamed vars)
		return new RegExp(escaped, "gi");
	} catch {
		// Invalid regex (shouldn't happen after escaping, but be safe)
		return null;
	}
}

function getLineNumber(content: string, index: number): number {
	return content.slice(0, index).split("\n").length;
}

function getSnippet(content: string, start: number, _length: number): string {
	const lines = content.split("\n");
	const lineNum = getLineNumber(content, start);
	const startLine = Math.max(0, lineNum - 2);
	const endLine = Math.min(lines.length, lineNum + 1);
	return lines.slice(startLine, endLine).join("\n").trim();
}

function formatMatchPreview(match: MatchPreview): string {
	const simPct = match.similarity
		? ` (${Math.round(match.similarity * 100)}% similar)`
		: "";
	return `• Line ${match.line}${simPct}: ${match.snippet}`;
}
