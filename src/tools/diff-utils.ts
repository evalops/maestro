import * as Diff from "diff";
import type { LspDiagnostic } from "../lsp/index.js";

/**
 * Format LSP diagnostics for user/agent display
 */
export function formatLspDiagnostics(
	path: string,
	diagnostics: LspDiagnostic[],
): string {
	if (!diagnostics || diagnostics.length === 0) return "";

	// Filter out low severity/noise if needed, but for now show everything relevant
	// Limit to top 5 to prevent context flooding
	const topDiagnostics = diagnostics.slice(0, 5);
	const lines = [`\nLinter check for ${path}:`];

	for (const diag of topDiagnostics) {
		const line = diag.range.start.line + 1;
		const severityLabels: Record<number, string> = {
			1: "Error",
			2: "Warning",
			3: "Info",
			4: "Hint",
		};
		const sev = severityLabels[diag.severity ?? 2] ?? "Warning";
		lines.push(`  [${sev}] Line ${line}: ${diag.message}`);
	}

	if (diagnostics.length > 5) {
		lines.push(`  ...and ${diagnostics.length - 5} more.`);
	}

	return lines.join("\n");
}

/**
 * Generate a unified diff-like string with line numbers and limited context.
 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): string {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i]!;
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			const nextPart = parts[i + 1];
			const nextPartIsChange =
				nextPart !== undefined && (nextPart.added || nextPart.removed);

			if (lastWasChange || nextPartIsChange) {
				let linesToShow = raw;
				let skipStart = 0;
				let skipEnd = 0;

				if (!lastWasChange) {
					skipStart = Math.max(0, raw.length - contextLines);
					linesToShow = raw.slice(skipStart);
				}

				if (!nextPartIsChange && linesToShow.length > contextLines) {
					skipEnd = linesToShow.length - contextLines;
					linesToShow = linesToShow.slice(0, contextLines);
				}

				if (skipStart > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				}

				for (const line of linesToShow) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skipEnd > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				}

				oldLineNum += skipStart + skipEnd;
				newLineNum += skipStart + skipEnd;
			} else {
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return output.join("\n");
}
