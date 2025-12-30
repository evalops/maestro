import { visibleWidth } from "@evalops/tui";
import chalk from "chalk";
import * as Diff from "diff";
import { highlightCodeLines } from "../../style/code-highlighter.js";
import { getHomeDir } from "../../utils/path-expansion.js";

const normalizeForCompare = (value: string): string =>
	process.platform === "win32" ? value.toLowerCase() : value;

const DEFAULT_TOOL_MAX_CHARS = 12000;
const DEFAULT_TOOL_MAX_LINES = 200;

export type ToolOutputLimits = {
	maxChars: number;
	maxLines: number;
};

export type ToolOutputClampResult = {
	text: string;
	truncated: boolean;
	omittedChars: number;
	omittedLines: number;
};

function parseLimit(raw: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(raw ?? "", 10);
	if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	return fallback;
}

export function getToolOutputLimits(): ToolOutputLimits {
	return {
		maxChars: parseLimit(
			process.env.COMPOSER_TUI_TOOL_MAX_CHARS,
			DEFAULT_TOOL_MAX_CHARS,
		),
		maxLines: parseLimit(
			process.env.COMPOSER_TUI_TOOL_MAX_LINES,
			DEFAULT_TOOL_MAX_LINES,
		),
	};
}

export function clampToolOutput(
	output: string,
	limits: ToolOutputLimits = getToolOutputLimits(),
): ToolOutputClampResult {
	if (!output) {
		return { text: "", truncated: false, omittedChars: 0, omittedLines: 0 };
	}

	const maxLines = limits.maxLines;
	const maxChars = limits.maxChars;
	const lines = output.split("\n");

	let text = output;
	let omittedLines = 0;
	if (maxLines > 0 && lines.length > maxLines) {
		text = lines.slice(0, maxLines).join("\n");
		omittedLines = lines.length - maxLines;
	}

	let omittedChars = 0;
	if (maxChars > 0 && text.length > maxChars) {
		omittedChars = text.length - maxChars;
		text = text.slice(0, maxChars);
	}

	const truncated = omittedLines > 0 || omittedChars > 0;
	return { text, truncated, omittedChars, omittedLines };
}

export function formatToolOutputTruncation(
	result: ToolOutputClampResult,
): string | null {
	if (!result.truncated) return null;
	const parts: string[] = [];
	if (result.omittedLines > 0) {
		parts.push(`${result.omittedLines.toLocaleString()} lines`);
	}
	if (result.omittedChars > 0) {
		parts.push(`${result.omittedChars.toLocaleString()} chars`);
	}
	const detail = parts.join(", ");
	return detail ? `[output truncated: ${detail} omitted]` : null;
}

export function shortenPath(path: string): string {
	const home = getHomeDir();
	const normalizedPath = path.replace(/\\/g, "/");
	const normalizedHome = home.replace(/\\/g, "/");
	const pathCheck = normalizeForCompare(normalizedPath);
	const homeCheck = normalizeForCompare(normalizedHome);
	if (pathCheck === homeCheck) {
		return "~";
	}
	if (pathCheck.startsWith(`${homeCheck}/`)) {
		return `~${normalizedPath.slice(normalizedHome.length)}`;
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

type DetailSectionOptions = {
	excludeKeys?: string[];
};

export function formatDetailSections(
	details: unknown,
	options?: DetailSectionOptions,
): string[] {
	if (!details || typeof details !== "object") {
		return [];
	}
	const exclude = new Set(
		(options?.excludeKeys || []).map((key) => key.toLowerCase()),
	);
	const sections: string[] = [];
	for (const [rawKey, value] of Object.entries(details)) {
		if (value === undefined || value === null) continue;
		if (exclude.has(rawKey.toLowerCase())) continue;
		const lines = formatDetailValueLines(value);
		if (!lines.length) continue;
		sections.push(formatSection(humanizeDetailKey(rawKey), lines));
	}
	return sections;
}

function formatDetailValueLines(value: unknown): string[] {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed ? trimmed.split(/\r?\n/).map((line) => chalk.dim(line)) : [];
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return [chalk.bold(String(value))];
	}
	if (Array.isArray(value)) {
		if (value.length === 0) {
			return [chalk.dim("[]")];
		}
		const primitiveItems = value.every(
			(item) => typeof item === "string" || typeof item === "number",
		);
		if (primitiveItems) {
			return value.slice(0, 8).map((item) => chalk.dim(`- ${item}`));
		}
		return formatJsonSnippet(value);
	}
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length === 0) {
			return [chalk.dim("{}")];
		}
		return formatJsonSnippet(value);
	}
	return [String(value ?? "")];
}

function humanizeDetailKey(key: string): string {
	const withSpaces = key
		.replace(/[_-]+/g, " ")
		.replace(/([a-z])([A-Z])/g, "$1 $2");
	return withSpaces.trim() || "details";
}

/**
 * Clamp ANSI-colored lines to a max visible width without breaking escape codes.
 * Adds an ellipsis if truncation occurs.
 */
export function clampAnsiLines(lines: string[], maxWidth: number): string[] {
	return lines.map((line) => clampAnsiLine(line, maxWidth));
}

function clampAnsiLine(line: string, maxWidth: number): string {
	if (maxWidth <= 0) return line;
	const lineWidth = visibleWidth(line);
	if (lineWidth <= maxWidth) return line;

	let visible = 0;
	let i = 0;
	let out = "";
	while (i < line.length) {
		const char = line[i];
		if (char === "\u001b") {
			// Skip over ANSI escape sequence without counting width
			let j = i + 1;
			// CSI sequences end with a final byte in the range @-~
			while (j < line.length) {
				const code = line[j];
				if (code >= "@" && code <= "~") {
					j += 1;
					break;
				}
				j += 1;
			}
			out += line.slice(i, j);
			i = j;
			continue;
		}
		// Handle multi-byte characters (emoji, etc.)
		const codePoint = line.codePointAt(i);
		if (codePoint === undefined) break;
		const grapheme = String.fromCodePoint(codePoint);
		const charWidth = visibleWidth(grapheme);

		if (visible + charWidth > maxWidth) {
			break;
		}
		out += grapheme;
		i += grapheme.length;
		visible += charWidth;
	}
	// Reserve space for ellipsis
	const ellipsis = "…";
	// Remove last visible char if necessary
	while (visibleWidth(out) > Math.max(1, maxWidth - 1)) {
		out = out.slice(0, -1);
	}
	out += ellipsis;
	// Ensure we reset styling if we truncated mid-ANSI sequence so downstream
	// output doesn't inherit colors.
	if (out.includes("\x1b[") && !out.endsWith("\x1b[0m")) {
		out += "\x1b[0m";
	}
	return out;
}
