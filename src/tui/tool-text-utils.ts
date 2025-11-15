import * as os from "node:os";
import chalk from "chalk";
import * as Diff from "diff";
import { highlightCodeLines } from "../style/code-highlighter.js";

export function shortenPath(path: string): string {
	const home = os.homedir();
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

export function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

export function generateDiff(oldStr: string, newStr: string): string {
	const parts = Diff.diffLines(oldStr, newStr);
	const output: string[] = [];

	const oldLines = oldStr.split("\n");
	const newLines = newStr.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;
	const CONTEXT_LINES = 2;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(chalk.green(`${lineNum} ${line}`));
					newLineNum++;
				} else {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(chalk.red(`${lineNum} ${line}`));
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			const isFirstPart = i === 0;
			const isLastPart = i === parts.length - 1;
			const nextPartIsChange =
				i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);

			if (lastWasChange || nextPartIsChange || isFirstPart || isLastPart) {
				let linesToShow = raw;
				let skipStart = 0;
				let skipEnd = 0;

				if (!isFirstPart && !lastWasChange) {
					skipStart = Math.max(0, raw.length - CONTEXT_LINES);
					linesToShow = raw.slice(skipStart);
				}

				if (
					!isLastPart &&
					!nextPartIsChange &&
					linesToShow.length > CONTEXT_LINES
				) {
					skipEnd = linesToShow.length - CONTEXT_LINES;
					linesToShow = linesToShow.slice(0, CONTEXT_LINES);
				}

				if (skipStart > 0) {
					output.push(chalk.dim(`${"".padStart(lineNumWidth, " ")} ...`));
				}

				for (const line of linesToShow) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(chalk.dim(`${lineNum} ${line}`));
					oldLineNum++;
					newLineNum++;
				}

				if (skipEnd > 0) {
					output.push(chalk.dim(`${"".padStart(lineNumWidth, " ")} ...`));
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

export function buildCollapsedSummary(source?: string): string {
	if (!source || !source.trim()) {
		return "output hidden";
	}
	const firstLine = source.split("\n").find((line) => line.trim()) || "";
	const trimmed = firstLine.trim();
	if (!trimmed) return "output hidden";
	const snippet = trimmed.slice(0, 80);
	return `output hidden: ${snippet}${
		trimmed.length > snippet.length ? "…" : ""
	}`;
}

export function summarizeLines(
	source: string,
	maxLines: number,
): { lines: string[]; remaining: number } {
	if (!source) {
		return { lines: [], remaining: 0 };
	}
	const lines = source.split("\n");
	if (maxLines <= 0 || lines.length <= maxLines) {
		return { lines, remaining: 0 };
	}
	return {
		lines: lines.slice(0, maxLines),
		remaining: lines.length - maxLines,
	};
}

export function formatSection(title: string, bodyLines: string[]): string {
	if (bodyLines.length === 0) {
		return "";
	}
	const header = chalk.hex("#c7d2fe").bold(title.toUpperCase());
	const body = bodyLines.map((line) => `  ${line}`).join("\n");
	return `${header}\n${body}`;
}

export function formatJsonSnippet(value: unknown): string[] {
	try {
		const stringified = JSON.stringify(value, null, 2);
		return stringified ? highlightCodeLines(stringified, "json") : [];
	} catch {
		return [];
	}
}

export function formatShellSnippet(value: string): string[] {
	if (!value) return [];
	return highlightCodeLines(value, "bash");
}
