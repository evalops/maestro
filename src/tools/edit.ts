import crypto from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, rename, unlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import { resolve as resolvePath } from "node:path";
import { Type } from "@sinclair/typebox";
import { collectDiagnostics } from "../lsp/index.js";
import {
	requirePlanCheck,
	runValidatorsOnSuccess,
} from "../safety/safe-mode.js";
import type { ValidatorRunResult } from "../safety/safe-mode.js";
import { generateDiffString } from "./diff-utils.js";
import { createTypeboxTool } from "./typebox-tool.js";

/**
 * Expand ~ to home directory
 */
function expandPath(filePath: string): string {
	if (filePath === "~") {
		return os.homedir();
	}
	if (filePath.startsWith("~/")) {
		return os.homedir() + filePath.slice(1);
	}
	return filePath;
}

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
	occurrence: Type.Optional(
		Type.Integer({
			description: "Which occurrence of the text to replace (1-based)",
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

export const editTool = createTypeboxTool({
	name: "edit",
	label: "edit",
	description:
		"Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.",
	schema: editSchema,
	async execute(
		_toolCallId,
		{ path, oldText, newText, occurrence = 1, dryRun = false },
		signal,
	) {
		const absolutePath = resolvePath(expandPath(path));
		requirePlanCheck("edit");

		return new Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: { diff: string; validators?: unknown } | undefined;
		}>((resolve, reject) => {
			// Check if already aborted
			if (signal?.aborted) {
				reject(new Error("Operation aborted"));
				return;
			}

			let aborted = false;

			// Set up abort handler
			const onAbort = () => {
				aborted = true;
				reject(new Error("Operation aborted"));
			};

			if (signal) {
				signal.addEventListener("abort", onAbort, { once: true });
			}

			// Perform the edit operation
			(async () => {
				try {
					// Check if file exists
					try {
						await access(absolutePath, constants.R_OK | constants.W_OK);
					} catch {
						if (signal) {
							signal.removeEventListener("abort", onAbort);
						}
						reject(new Error(`File not found: ${path}`));
						return;
					}

					// Check if aborted before reading
					if (aborted) {
						return;
					}

					// Read the file
					const content = await readFile(absolutePath, "utf-8");

					// Check if aborted after reading
					if (aborted) {
						return;
					}

					// Check if old text exists
					const exactMatches = findExactMatches(content, oldText);
					if (exactMatches.length === 0) {
						const approx = findApproximateMatches(content, oldText);
						const suggestion = approx.length
							? `\n\nPossible matches:\n${approx
									.slice(0, 3)
									.map(formatMatchPreview)
									.join("\n")}`
							: `\n\nTip: double-check whitespace/newlines via /diff ${path}`;
						if (signal) {
							signal.removeEventListener("abort", onAbort);
						}
						reject(
							new Error(
								`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.${suggestion}`,
							),
						);
						return;
					}

					if (occurrence > exactMatches.length) {
						if (signal) {
							signal.removeEventListener("abort", onAbort);
						}
						reject(
							new Error(
								`Only ${exactMatches.length} occurrence(s) found in ${path}, but occurrence #${occurrence} was requested`,
							),
						);
						return;
					}

					const targetMatch = exactMatches[occurrence - 1];
					const matchIndex = targetMatch.index ?? 0;

					// Check if aborted before writing
					if (aborted) {
						return;
					}

					const newContent =
						content.slice(0, matchIndex) +
						newText +
						content.slice(matchIndex + oldText.length);

					const diff = generateDiffString(content, newContent);

					if (dryRun) {
						if (signal) {
							signal.removeEventListener("abort", onAbort);
						}
						resolve({
							content: [
								{
									type: "text",
									text: `Dry run: preview for ${path} (occurrence #${occurrence}). No changes written.`,
								},
							],
							details: { diff },
						});
						return;
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
						if (signal) {
							signal.removeEventListener("abort", onAbort);
						}
						reject(validatorError);
						return;
					}

					// Check if aborted after writing
					if (aborted) {
						return;
					}

					// Clean up abort handler
					if (signal) {
						signal.removeEventListener("abort", onAbort);
					}

					resolve({
						content: [
							{
								type: "text",
								text: `Successfully replaced ${oldText.length} characters with ${newText.length} characters in ${path}${exactMatches.length > 1 ? ` (occurrence #${occurrence} of ${exactMatches.length})` : ""}.`,
							},
						],
						details: {
							diff,
							validators: validatorSummaries,
						},
					});
				} catch (error: unknown) {
					// Clean up abort handler
					if (signal) {
						signal.removeEventListener("abort", onAbort);
					}

					if (!aborted) {
						reject(error instanceof Error ? error : new Error(String(error)));
					}
				}
			})();
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
