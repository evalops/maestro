/**
 * Intelligent Output Filter
 *
 * Smart truncation of command output that preserves important information
 * (especially errors) while reducing token usage for verbose output.
 *
 * ## Features
 *
 * - Keeps head (first N lines) and tail (last M lines)
 * - Extracts error-related lines from truncated middle
 * - Recognizes error patterns across multiple languages
 * - Filters common noise (progress bars, download logs)
 *
 * ## Usage
 *
 * ```typescript
 * import { filterOutput, OutputFilterOptions } from "./output-filter.js";
 *
 * const filtered = filterOutput(verboseOutput, {
 *   maxLines: 200,
 *   headLines: 50,
 *   tailLines: 100,
 *   extractErrors: true,
 * });
 * ```
 */

import { createLogger } from "./logger.js";

const logger = createLogger("utils:output-filter");

/**
 * Output filter options
 */
export interface OutputFilterOptions {
	/** Maximum lines before truncation (default: 200) */
	maxLines?: number;
	/** Lines to keep from start (default: 50) */
	headLines?: number;
	/** Lines to keep from end (default: 100) */
	tailLines?: number;
	/** Extract error lines from middle (default: true) */
	extractErrors?: boolean;
	/** Context lines around errors (default: 2) */
	errorContext?: number;
	/** Filter noise patterns (default: true) */
	filterNoise?: boolean;
	/** Maximum output length in characters (default: 50000) */
	maxChars?: number;
}

/**
 * Filter result with metadata
 */
export interface FilterResult {
	/** Filtered output */
	output: string;
	/** Whether output was truncated */
	truncated: boolean;
	/** Original line count */
	originalLines: number;
	/** Filtered line count */
	filteredLines: number;
	/** Number of error lines extracted */
	errorLinesExtracted: number;
	/** Truncation summary message */
	summary?: string;
}

/**
 * Error patterns for various languages/tools
 */
const ERROR_PATTERNS: RegExp[] = [
	// Generic errors
	/\berror\b/i,
	/\bfailed\b/i,
	/\bfailure\b/i,
	/\bexception\b/i,
	/\bfatal\b/i,
	/\bcrash(ed)?\b/i,
	/\babort(ed)?\b/i,
	/\bpanic\b/i,

	// Stack traces
	/^\s+at\s+/,
	/^\s+File\s+"/,
	/Traceback \(most recent/,
	/^\s+\d+\s+\|/,

	// Exit codes
	/exit(ed)?\s+(with\s+)?(code|status)\s+[1-9]/i,
	/return(ed)?\s+(code|status)\s+[1-9]/i,

	// Python
	/^\w+Error:/,
	/^\w+Exception:/,
	/^ModuleNotFoundError:/,
	/^ImportError:/,
	/^SyntaxError:/,
	/^TypeError:/,
	/^ValueError:/,
	/^KeyError:/,
	/^AttributeError:/,

	// JavaScript/TypeScript
	/^ReferenceError:/,
	/^SyntaxError:/,
	/^TypeError:/,
	/^RangeError:/,
	/Cannot find module/,
	/is not defined$/,
	/is not a function$/,

	// Rust
	/^error\[E\d+\]:/,
	/^thread '.*' panicked/,
	/note: run with `RUST_BACKTRACE/,

	// Go
	/^panic:/,
	/^fatal error:/,
	/undefined:/,

	// Java
	/^\s+at\s+[\w.$]+\(/,
	/^Caused by:/,
	/^java\.\w+\.\w+Exception/,

	// C/C++
	/^Segmentation fault/,
	/^Bus error/,
	/undefined reference to/,
	/error: ld returned/,

	// Build tools
	/^FAILED:/,
	/^BUILD FAILED/,
	/^\[ERROR\]/,
	/^npm ERR!/,
	/^yarn error/,
	/^error: Recipe .* failed/,

	// Test failures
	/FAIL\s+\S+/,
	/^✗|^✘|^×/,
	/\d+ failing/,
	/AssertionError/,
	/assertion failed/i,

	// Warnings (lower priority but still useful)
	/\bwarning\b/i,
	/\bdeprecated\b/i,
];

/**
 * Noise patterns to filter out
 */
const NOISE_PATTERNS: RegExp[] = [
	// Progress indicators
	/^\s*\d+%/,
	/\[\s*=*>?\s*\]/,
	/\.{3,}/,
	/⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/,

	// Download/install progress
	/^Downloading\s+/,
	/^Installing\s+/,
	/^Extracting\s+/,
	/^Unpacking\s+/,
	/^\s*\d+\s+(B|KB|MB|GB)\s+(\/|\|)\s+/,

	// npm/yarn noise
	/^npm WARN/,
	/^npm notice/,
	/added \d+ packages/,
	/^Resolving: /,

	// pip noise
	/^Collecting\s+/,
	/^Requirement already satisfied/,
	/^Using cached/,

	// Git noise
	/^remote:\s*$/,
	/Counting objects:/,
	/Compressing objects:/,
	/Receiving objects:/,

	// Empty or whitespace-only
	/^\s*$/,

	// ANSI escape sequences (already handled but just in case)
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional escape sequence pattern
	/\x1b\[[0-9;]*m/g,
];

/**
 * Check if a line is an error line
 */
function isErrorLine(line: string): boolean {
	return ERROR_PATTERNS.some((pattern) => pattern.test(line));
}

/**
 * Check if a line is noise
 */
function isNoiseLine(line: string): boolean {
	return NOISE_PATTERNS.some((pattern) => pattern.test(line));
}

/**
 * Extract error lines with context from a range of lines
 */
function extractErrorsWithContext(
	lines: string[],
	startIdx: number,
	endIdx: number,
	contextLines: number,
): string[] {
	const errorIndices: number[] = [];

	// Find all error lines in range
	for (let i = startIdx; i < endIdx; i++) {
		if (isErrorLine(lines[i] || "")) {
			errorIndices.push(i);
		}
	}

	if (errorIndices.length === 0) {
		return [];
	}

	// Collect error lines with context, avoiding duplicates
	const includedIndices = new Set<number>();
	for (const idx of errorIndices) {
		for (
			let i = Math.max(startIdx, idx - contextLines);
			i <= Math.min(endIdx - 1, idx + contextLines);
			i++
		) {
			includedIndices.add(i);
		}
	}

	// Sort and collect lines
	const sortedIndices = Array.from(includedIndices).sort((a, b) => a - b);
	const result: string[] = [];
	let lastIdx = -1;

	for (const idx of sortedIndices) {
		// Add ellipsis if there's a gap
		if (lastIdx >= 0 && idx > lastIdx + 1) {
			result.push("...");
		}
		result.push(lines[idx] || "");
		lastIdx = idx;
	}

	return result;
}

/**
 * Filter command output intelligently
 */
export function filterOutput(
	output: string,
	options: OutputFilterOptions = {},
): FilterResult {
	const {
		maxLines = 200,
		headLines = 50,
		tailLines = 100,
		extractErrors = true,
		errorContext = 2,
		filterNoise = true,
		maxChars = 50000,
	} = options;

	// Split into lines
	let lines = output.split("\n");
	const originalLines = lines.length;

	// Filter noise if enabled
	if (filterNoise) {
		lines = lines.filter((line) => !isNoiseLine(line));
	}

	// Check if truncation is needed
	if (lines.length <= maxLines && output.length <= maxChars) {
		return {
			output: lines.join("\n"),
			truncated: false,
			originalLines,
			filteredLines: lines.length,
			errorLinesExtracted: 0,
		};
	}

	// Calculate truncation boundaries
	const effectiveHead = Math.min(headLines, Math.floor(maxLines * 0.3));
	const effectiveTail = Math.min(tailLines, Math.floor(maxLines * 0.5));
	const middleStart = effectiveHead;
	const middleEnd = lines.length - effectiveTail;

	// Extract sections
	const headSection = lines.slice(0, effectiveHead);
	const tailSection = lines.slice(-effectiveTail);

	// Extract errors from middle if enabled
	let errorSection: string[] = [];
	let errorLinesExtracted = 0;

	if (extractErrors && middleEnd > middleStart) {
		errorSection = extractErrorsWithContext(
			lines,
			middleStart,
			middleEnd,
			errorContext,
		);
		errorLinesExtracted = errorSection.filter((l) => l !== "...").length;
	}

	// Build truncated output
	const truncatedLines = middleEnd - middleStart;
	const truncationMarker = `\n... [${truncatedLines} lines truncated] ...\n`;

	let result: string;
	if (errorSection.length > 0) {
		result = [
			...headSection,
			truncationMarker,
			"--- Extracted errors from truncated section ---",
			...errorSection,
			"--- End of extracted errors ---",
			truncationMarker,
			...tailSection,
		].join("\n");
	} else {
		result = [...headSection, truncationMarker, ...tailSection].join("\n");
	}

	// Enforce character limit
	if (result.length > maxChars) {
		result = `${result.slice(0, maxChars)}\n... [output truncated at character limit]`;
	}

	const summary = `Output truncated: ${originalLines} → ${headSection.length + tailSection.length + errorSection.length} lines`;

	logger.debug("Output filtered", {
		originalLines,
		headLines: headSection.length,
		tailLines: tailSection.length,
		errorLinesExtracted,
		truncatedLines,
	});

	return {
		output: result,
		truncated: true,
		originalLines,
		filteredLines:
			headSection.length + tailSection.length + errorSection.length,
		errorLinesExtracted,
		summary,
	};
}

/**
 * Quick check if output needs filtering
 */
export function needsFiltering(
	output: string,
	maxLines = 200,
	maxChars = 50000,
): boolean {
	if (output.length > maxChars) return true;

	let lineCount = 0;
	for (let i = 0; i < output.length; i++) {
		if (output[i] === "\n") {
			lineCount++;
			if (lineCount > maxLines) return true;
		}
	}
	return false;
}

/**
 * Extract just the error lines from output
 */
export function extractErrors(output: string): string[] {
	return output.split("\n").filter(isErrorLine);
}

/**
 * Get a summary of output without full content
 */
export function summarizeOutput(output: string): string {
	const lines = output.split("\n");
	const errorLines = lines.filter(isErrorLine);
	const hasErrors = errorLines.length > 0;

	const parts = [`${lines.length} lines`, `${output.length} chars`];

	if (hasErrors) {
		parts.push(`${errorLines.length} error lines`);
	}

	return parts.join(", ");
}
