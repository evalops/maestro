/**
 * Diff Preview
 *
 * Shows a preview of changes before applying them, similar to Cursor's
 * diff view. Enables users to review and approve changes before they're
 * written to disk.
 *
 * ## Features
 *
 * - Generate unified diffs from edits
 * - Side-by-side comparison view
 * - Hunk-level approval/rejection
 * - Syntax highlighting support
 * - Integration with undo system
 *
 * ## Usage
 *
 * ```typescript
 * import { diffPreview } from "./diff-preview.js";
 *
 * // Create preview for an edit
 * const preview = await diffPreview.createPreview({
 *   filePath: "src/main.ts",
 *   originalContent: "...",
 *   newContent: "...",
 * });
 *
 * // Format for display
 * const formatted = diffPreview.formatUnified(preview);
 * ```
 */

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("tools:diff-preview");

/**
 * A single line in a diff
 */
export interface DiffLine {
	type: "context" | "add" | "remove" | "header";
	content: string;
	oldLineNum?: number;
	newLineNum?: number;
}

/**
 * A hunk in a diff
 */
export interface DiffHunk {
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	lines: DiffLine[];
	header: string;
}

/**
 * Complete diff preview
 */
export interface DiffPreviewResult {
	filePath: string;
	fileName: string;
	hunks: DiffHunk[];
	additions: number;
	deletions: number;
	isNewFile: boolean;
	isDeleted: boolean;
	originalContent: string;
	newContent: string;
}

/**
 * Preview configuration
 */
export interface PreviewConfig {
	filePath: string;
	originalContent?: string;
	newContent: string;
	contextLines?: number;
}

/**
 * Apply mode for changes
 */
export type ApplyMode = "all" | "hunks" | "lines";

/**
 * Compute longest common subsequence for diff algorithm
 */
function computeLCS(a: string[], b: string[]): number[][] {
	const m = a.length;
	const n = b.length;
	const dp: number[][] = Array(m + 1)
		.fill(null)
		.map(() => Array(n + 1).fill(0));

	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			if (a[i - 1] === b[j - 1]) {
				dp[i]![j] = (dp[i - 1]?.[j - 1] || 0) + 1;
			} else {
				dp[i]![j] = Math.max(dp[i - 1]?.[j] || 0, dp[i]?.[j - 1] || 0);
			}
		}
	}

	return dp;
}

/**
 * Generate diff between two arrays of lines
 */
function generateDiff(
	oldLines: string[],
	newLines: string[],
	contextLines = 3,
): DiffHunk[] {
	const dp = computeLCS(oldLines, newLines);
	const operations: Array<{
		type: "keep" | "add" | "remove";
		line: string;
		oldIdx?: number;
		newIdx?: number;
	}> = [];

	// Backtrack to find the diff
	let i = oldLines.length;
	let j = newLines.length;

	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
			operations.unshift({
				type: "keep",
				line: oldLines[i - 1]!,
				oldIdx: i - 1,
				newIdx: j - 1,
			});
			i--;
			j--;
		} else if (
			j > 0 &&
			(i === 0 || (dp[i]?.[j - 1] || 0) >= (dp[i - 1]?.[j] || 0))
		) {
			operations.unshift({
				type: "add",
				line: newLines[j - 1]!,
				newIdx: j - 1,
			});
			j--;
		} else {
			operations.unshift({
				type: "remove",
				line: oldLines[i - 1]!,
				oldIdx: i - 1,
			});
			i--;
		}
	}

	// Convert operations to hunks
	const hunks: DiffHunk[] = [];
	let currentHunk: DiffHunk | null = null;
	let lastChangeIdx = Number.NEGATIVE_INFINITY;

	for (let opIdx = 0; opIdx < operations.length; opIdx++) {
		const op = operations[opIdx]!;
		const isChange = op.type !== "keep";

		if (isChange) {
			// Start a new hunk or extend the current one
			if (!currentHunk || opIdx - lastChangeIdx > contextLines * 2) {
				// Start new hunk
				if (currentHunk) {
					hunks.push(currentHunk);
				}

				const startIdx = Math.max(0, opIdx - contextLines);
				currentHunk = {
					oldStart: (operations[startIdx]?.oldIdx ?? 0) + 1,
					oldCount: 0,
					newStart: (operations[startIdx]?.newIdx ?? 0) + 1,
					newCount: 0,
					lines: [],
					header: "",
				};

				// Add leading context
				for (let ctx = startIdx; ctx < opIdx; ctx++) {
					const ctxOp = operations[ctx];
					if (ctxOp && ctxOp.type === "keep") {
						currentHunk.lines.push({
							type: "context",
							content: ctxOp.line,
							oldLineNum: (ctxOp.oldIdx ?? 0) + 1,
							newLineNum: (ctxOp.newIdx ?? 0) + 1,
						});
						currentHunk.oldCount++;
						currentHunk.newCount++;
					}
				}
			}

			lastChangeIdx = opIdx;
		}

		if (currentHunk) {
			if (op.type === "keep") {
				// Check if we should add trailing context
				if (opIdx - lastChangeIdx <= contextLines) {
					currentHunk.lines.push({
						type: "context",
						content: op.line,
						oldLineNum: (op.oldIdx ?? 0) + 1,
						newLineNum: (op.newIdx ?? 0) + 1,
					});
					currentHunk.oldCount++;
					currentHunk.newCount++;
				}
			} else if (op.type === "add") {
				currentHunk.lines.push({
					type: "add",
					content: op.line,
					newLineNum: (op.newIdx ?? 0) + 1,
				});
				currentHunk.newCount++;
			} else if (op.type === "remove") {
				currentHunk.lines.push({
					type: "remove",
					content: op.line,
					oldLineNum: (op.oldIdx ?? 0) + 1,
				});
				currentHunk.oldCount++;
			}
		}
	}

	if (currentHunk) {
		hunks.push(currentHunk);
	}

	// Generate headers for hunks
	for (const hunk of hunks) {
		hunk.header = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
	}

	return hunks;
}

/**
 * Diff preview manager
 */
class DiffPreviewManager {
	private pendingPreviews = new Map<string, DiffPreviewResult>();

	/**
	 * Create a diff preview for an edit
	 */
	async createPreview(config: PreviewConfig): Promise<DiffPreviewResult> {
		const { filePath, newContent, contextLines = 3 } = config;
		let originalContent = config.originalContent;

		// Read original content if not provided
		if (originalContent === undefined) {
			if (existsSync(filePath)) {
				originalContent = readFileSync(filePath, "utf-8");
			} else {
				originalContent = "";
			}
		}

		const isNewFile = originalContent === "";
		const isDeleted = newContent === "";

		const oldLines = originalContent.split("\n");
		const newLines = newContent.split("\n");

		const hunks = generateDiff(oldLines, newLines, contextLines);

		// Count additions and deletions
		let additions = 0;
		let deletions = 0;
		for (const hunk of hunks) {
			for (const line of hunk.lines) {
				if (line.type === "add") additions++;
				if (line.type === "remove") deletions++;
			}
		}

		const preview: DiffPreviewResult = {
			filePath,
			fileName: basename(filePath),
			hunks,
			additions,
			deletions,
			isNewFile,
			isDeleted,
			originalContent,
			newContent,
		};

		// Store for later application
		this.pendingPreviews.set(filePath, preview);

		logger.debug("Diff preview created", {
			filePath,
			hunks: hunks.length,
			additions,
			deletions,
		});

		return preview;
	}

	/**
	 * Format diff as unified diff string
	 */
	formatUnified(preview: DiffPreviewResult): string {
		const lines: string[] = [
			`--- a/${preview.fileName}`,
			`+++ b/${preview.fileName}`,
		];

		for (const hunk of preview.hunks) {
			lines.push(hunk.header);
			for (const line of hunk.lines) {
				switch (line.type) {
					case "context":
						lines.push(` ${line.content}`);
						break;
					case "add":
						lines.push(`+${line.content}`);
						break;
					case "remove":
						lines.push(`-${line.content}`);
						break;
				}
			}
		}

		return lines.join("\n");
	}

	/**
	 * Format diff with color codes for terminal
	 */
	formatColored(preview: DiffPreviewResult): string {
		const RED = "\x1b[31m";
		const GREEN = "\x1b[32m";
		const CYAN = "\x1b[36m";
		const RESET = "\x1b[0m";
		const DIM = "\x1b[2m";

		const lines: string[] = [
			`${DIM}--- a/${preview.fileName}${RESET}`,
			`${DIM}+++ b/${preview.fileName}${RESET}`,
		];

		for (const hunk of preview.hunks) {
			lines.push(`${CYAN}${hunk.header}${RESET}`);
			for (const line of hunk.lines) {
				switch (line.type) {
					case "context":
						lines.push(`${DIM} ${line.content}${RESET}`);
						break;
					case "add":
						lines.push(`${GREEN}+${line.content}${RESET}`);
						break;
					case "remove":
						lines.push(`${RED}-${line.content}${RESET}`);
						break;
				}
			}
		}

		return lines.join("\n");
	}

	/**
	 * Format diff as side-by-side comparison
	 */
	formatSideBySide(preview: DiffPreviewResult, width = 80): string {
		const halfWidth = Math.floor(width / 2) - 3;
		const lines: string[] = [];

		// Header
		const leftHeader = `Old (${preview.deletions} deletions)`.padEnd(halfWidth);
		const rightHeader = `New (${preview.additions} additions)`.padEnd(
			halfWidth,
		);
		lines.push(`${leftHeader} │ ${rightHeader}`);
		lines.push(`${"─".repeat(halfWidth)}─┼─${"─".repeat(halfWidth)}`);

		for (const hunk of preview.hunks) {
			const oldLines: Array<{ num: number; content: string }> = [];
			const newLines: Array<{ num: number; content: string }> = [];

			for (const line of hunk.lines) {
				if (line.type === "context") {
					oldLines.push({ num: line.oldLineNum!, content: line.content });
					newLines.push({ num: line.newLineNum!, content: line.content });
				} else if (line.type === "remove") {
					oldLines.push({ num: line.oldLineNum!, content: line.content });
				} else if (line.type === "add") {
					newLines.push({ num: line.newLineNum!, content: line.content });
				}
			}

			// Pad to same length
			const maxLen = Math.max(oldLines.length, newLines.length);
			while (oldLines.length < maxLen) oldLines.push({ num: 0, content: "" });
			while (newLines.length < maxLen) newLines.push({ num: 0, content: "" });

			for (let i = 0; i < maxLen; i++) {
				const oldLine = oldLines[i]!;
				const newLine = newLines[i]!;

				const leftNum = oldLine.num ? String(oldLine.num).padStart(4) : "    ";
				const rightNum = newLine.num ? String(newLine.num).padStart(4) : "    ";

				const leftContent = oldLine.content
					.slice(0, halfWidth - 6)
					.padEnd(halfWidth - 5);
				const rightContent = newLine.content
					.slice(0, halfWidth - 6)
					.padEnd(halfWidth - 5);

				lines.push(`${leftNum} ${leftContent} │ ${rightNum} ${rightContent}`);
			}

			lines.push(`${"─".repeat(halfWidth)}─┼─${"─".repeat(halfWidth)}`);
		}

		return lines.join("\n");
	}

	/**
	 * Get pending preview for a file
	 */
	getPendingPreview(filePath: string): DiffPreviewResult | undefined {
		return this.pendingPreviews.get(filePath);
	}

	/**
	 * Clear pending preview for a file
	 */
	clearPreview(filePath: string): void {
		this.pendingPreviews.delete(filePath);
	}

	/**
	 * Clear all pending previews
	 */
	clearAllPreviews(): void {
		this.pendingPreviews.clear();
	}

	/**
	 * Get summary of all pending previews
	 */
	getSummary(): {
		totalFiles: number;
		totalAdditions: number;
		totalDeletions: number;
		files: Array<{ path: string; additions: number; deletions: number }>;
	} {
		let totalAdditions = 0;
		let totalDeletions = 0;
		const files: Array<{ path: string; additions: number; deletions: number }> =
			[];

		for (const [path, preview] of Array.from(this.pendingPreviews)) {
			totalAdditions += preview.additions;
			totalDeletions += preview.deletions;
			files.push({
				path,
				additions: preview.additions,
				deletions: preview.deletions,
			});
		}

		return {
			totalFiles: this.pendingPreviews.size,
			totalAdditions,
			totalDeletions,
			files,
		};
	}

	/**
	 * Apply specific hunks from a preview
	 */
	applyHunks(preview: DiffPreviewResult, hunkIndices: number[]): string {
		const oldLines = preview.originalContent.split("\n");
		const result = [...oldLines];
		let offset = 0;

		// Sort hunks by start position
		const sortedIndices = [...hunkIndices].sort((a, b) => {
			const hunkA = preview.hunks[a];
			const hunkB = preview.hunks[b];
			return (hunkA?.oldStart || 0) - (hunkB?.oldStart || 0);
		});

		for (const hunkIdx of sortedIndices) {
			const hunk = preview.hunks[hunkIdx];
			if (!hunk) continue;

			const startIdx = hunk.oldStart - 1 + offset;
			let removeCount = 0;
			const addLines: string[] = [];

			for (const line of hunk.lines) {
				if (line.type === "remove") {
					removeCount++;
				} else if (line.type === "add") {
					addLines.push(line.content);
				}
			}

			result.splice(startIdx, removeCount, ...addLines);
			offset += addLines.length - removeCount;
		}

		return result.join("\n");
	}
}

/**
 * Global diff preview manager instance
 */
export const diffPreview = new DiffPreviewManager();

/**
 * Quick function to preview an edit
 */
export async function previewEdit(
	filePath: string,
	newContent: string,
): Promise<string> {
	const preview = await diffPreview.createPreview({ filePath, newContent });
	return diffPreview.formatColored(preview);
}
