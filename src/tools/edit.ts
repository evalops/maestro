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
		{ signal, respond },
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

		try {
			await access(absolutePath, constants.R_OK | constants.W_OK);
		} catch {
			throw new Error(`File not found: ${path}`);
		}

		throwIfAborted();
		const originalContent = await readFile(absolutePath, "utf-8");
		throwIfAborted();

		let newContent: string;
		let replacementCount: number;

		if (hasMultiEdit) {
			// Multi-edit mode: apply edits sequentially
			let content = originalContent;
			let editsApplied = 0;

			for (const [index, edit] of edits.entries()) {
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
						`Edit #${index + 1}: Found ${matches.length} matches for oldText. Provide more context to uniquely identify the target. Matches at lines: ${matches.map((m) => m.line).join(", ")}`,
					);
				}
				const matchIndex = matches[0]?.index ?? 0;

				content =
					content.slice(0, matchIndex) +
					(edit.newText ?? "") +
					content.slice(matchIndex + edit.oldText.length);
				editsApplied++;
				throwIfAborted();
			}

			newContent = content;
			replacementCount = editsApplied;
		} else {
			// Single edit mode (original behavior)
			if (!oldText || oldText.length === 0) {
				throw new Error("oldText cannot be empty");
			}

			if (replaceAll && occurrence !== 1) {
				throw new Error(
					"Cannot use both replaceAll and occurrence parameters.",
				);
			}

			const exactMatches = findExactMatches(originalContent, oldText);
			if (exactMatches.length === 0) {
				const approx = findApproximateMatches(originalContent, oldText);
				const suggestion = approx.length
					? `\n\nPossible matches:\n${approx.slice(0, 3).map(formatMatchPreview).join("\n")}`
					: `\n\nTip: double-check whitespace/newlines via /diff ${path}`;
				throw new Error(
					`Could not find the exact text in ${path}.${suggestion}`,
				);
			}

			const MAX_REPLACEMENTS = 10000;

			if (replaceAll) {
				if (exactMatches.length > MAX_REPLACEMENTS) {
					throw new Error(
						`Too many replacements: ${exactMatches.length} (max ${MAX_REPLACEMENTS}).`,
					);
				}
				newContent = originalContent.replaceAll(oldText, newText ?? "");
				replacementCount = exactMatches.length;
			} else {
				if (occurrence > exactMatches.length) {
					throw new Error(
						`Only ${exactMatches.length} occurrence(s) found, but #${occurrence} requested.`,
					);
				}
				const targetMatch = exactMatches[occurrence - 1];
				const matchIndex = targetMatch.index ?? 0;
				newContent =
					originalContent.slice(0, matchIndex) +
					(newText ?? "") +
					originalContent.slice(matchIndex + oldText.length);
				replacementCount = 1;
			}
		}

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

function findApproximateMatches(
	content: string,
	snippet: string,
): MatchPreview[] {
	const relaxed = buildRelaxedRegex(snippet);
	if (!relaxed) return [];
	const matches: MatchPreview[] = [];
	let result: RegExpExecArray | null;
	while (matches.length < 5) {
		result = relaxed.exec(content);
		if (!result) {
			break;
		}
		const matchIndex = result.index;
		const matchLength = result[0]?.length ?? snippet.length;
		matches.push({
			line: getLineNumber(content, matchIndex),
			snippet: getSnippet(content, matchIndex, matchLength),
		});
	}
	return matches;
}

function buildRelaxedRegex(snippet: string): RegExp | null {
	const trimmed = snippet.trim();
	if (!trimmed) return null;
	const escaped = trimmed
		.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		.replace(/\s+/g, "\\s+");
	try {
		return new RegExp(escaped, "gi");
	} catch {
		return null;
	}
}

function getLineNumber(content: string, index: number): number {
	return content.slice(0, index).split("\n").length;
}

function getSnippet(content: string, start: number, length: number): string {
	const lines = content.split("\n");
	const lineNum = getLineNumber(content, start);
	const startLine = Math.max(0, lineNum - 2);
	const endLine = Math.min(lines.length, lineNum + 1);
	return lines.slice(startLine, endLine).join("\n").trim();
}

function formatMatchPreview(match: MatchPreview): string {
	return `• Line ${match.line}: ${match.snippet}`;
}
