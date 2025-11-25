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
import { generateDiffString } from "./diff-utils.js";
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

const editSchema = Type.Object({
	path: Type.String({
		description: "Path to the file to edit (relative or absolute)",
		minLength: 1,
	}),
	oldText: Type.String({
		description: "Exact text to find and replace (must match exactly)",
		minLength: 1,
	}),
	newText: Type.String({
		description: "New text to replace the old text with",
		default: "",
	}),
	replaceAll: Type.Optional(
		Type.Boolean({
			description:
				"Replace all occurrences (useful for variable renaming). Cannot be used with occurrence.",
			default: false,
		}),
	),
	occurrence: Type.Optional(
		Type.Integer({
			description:
				"Which occurrence of the text to replace (1-based). Cannot be used with replaceAll.",
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
	validators?: ValidatorRunResult[];
};

export const editTool = createTool<typeof editSchema, EditToolDetails>({
	name: "edit",
	label: "edit",
	description: `Edit files with find-and-replace. oldText must match exactly (whitespace, indentation, newlines).

Parameters:
- path: File path
- oldText: Exact text to find (must be unique unless using replaceAll)
- newText: Replacement (use "" to delete)
- replaceAll: Replace all occurrences (default: false). Useful for variable renaming.
- occurrence: Which match (default: 1). Cannot be used with replaceAll.
- dryRun: Preview only (default: false)

Best practices:
- Read file first to verify exact formatting
- Include context (5-10 lines) for uniqueness
- Match indentation style (tabs vs spaces)
- Use dryRun for complex edits
- Use replaceAll for variable renaming or bulk replacements

If "not found", read file to check actual content.`,
	schema: editSchema,
	async run(
		{
			path,
			oldText,
			newText,
			replaceAll = false,
			occurrence = 1,
			dryRun = false,
		},
		{ signal, respond },
	) {
		requirePlanCheck("edit");

		// Defense in depth: validate oldText is not empty (schema has minLength: 1)
		if (!oldText || oldText.length === 0) {
			throw new Error("oldText cannot be empty");
		}

		if (replaceAll && occurrence !== 1) {
			throw new Error(
				"Cannot use both replaceAll and occurrence parameters. Use replaceAll=true to replace all, or occurrence=N to replace a specific one.",
			);
		}

		const absolutePath = resolvePath(expandUserPath(path));
		const throwIfAborted = () => {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}
		};

		try {
			await access(absolutePath, constants.R_OK | constants.W_OK);
		} catch {
			throw new Error(`File not found: ${path}`);
		}

		throwIfAborted();
		const content = await readFile(absolutePath, "utf-8");
		throwIfAborted();

		const exactMatches = findExactMatches(content, oldText);
		if (exactMatches.length === 0) {
			const approx = findApproximateMatches(content, oldText);
			const suggestion = approx.length
				? `\n\nPossible matches:\n${approx
						.slice(0, 3)
						.map(formatMatchPreview)
						.join("\n")}`
				: `\n\nTip: double-check whitespace/newlines via /diff ${path}`;
			throw new Error(
				`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.${suggestion}`,
			);
		}

		let newContent: string;
		let replacementCount: number;

		// Safety limit to prevent DoS from excessive replacements
		const MAX_REPLACEMENTS = 10000;

		if (replaceAll) {
			// Check replacement count before proceeding
			if (exactMatches.length > MAX_REPLACEMENTS) {
				throw new Error(
					`Too many replacements: found ${exactMatches.length} occurrences (max ${MAX_REPLACEMENTS}). Use a more specific search pattern.`,
				);
			}

			// Use native replaceAll for better memory efficiency
			newContent = content.replaceAll(oldText, newText);
			replacementCount = exactMatches.length;
		} else {
			// Replace single occurrence
			if (occurrence > exactMatches.length) {
				throw new Error(
					`Only ${exactMatches.length} occurrence(s) found in ${path}, but occurrence #${occurrence} was requested`,
				);
			}

			const targetMatch = exactMatches[occurrence - 1];
			const matchIndex = targetMatch.index ?? 0;
			newContent =
				content.slice(0, matchIndex) +
				newText +
				content.slice(matchIndex + oldText.length);
			replacementCount = 1;
		}

		const diff = generateDiffString(content, newContent);

		if (dryRun) {
			const modeDesc = replaceAll
				? `all ${exactMatches.length} occurrence(s)`
				: `occurrence #${occurrence}`;
			return respond
				.text(`Dry run: preview for ${path} (${modeDesc}). No changes written.`)
				.detail({ diff });
		}

		await writeFileAtomically(absolutePath, newContent);
		let validatorSummaries: ValidatorRunResult[] | undefined;
		try {
			const lspDiagnostics = await collectDiagnostics();
			validatorSummaries = await runValidatorsOnSuccess(
				[absolutePath],
				lspDiagnostics,
			);
		} catch (validatorError) {
			await writeFileAtomically(absolutePath, content);
			throw validatorError;
		}

		throwIfAborted();

		const resultMessage = replaceAll
			? `Successfully replaced all ${replacementCount} occurrence(s) in ${path}.`
			: `Successfully replaced ${oldText.length} characters with ${newText.length} characters in ${path}${
					exactMatches.length > 1
						? ` (occurrence #${occurrence} of ${exactMatches.length})`
						: ""
				}.`;

		return respond
			.text(resultMessage)
			.detail({ diff, validators: validatorSummaries });
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
