/**
 * Token Optimizer
 *
 * Reduces token usage in prompts through intelligent compression techniques.
 * Helps fit more context within model limits and reduces API costs.
 *
 * ## Features
 *
 * - Deduplication of repeated content
 * - Summarization of verbose output
 * - Smart truncation preserving important information
 * - Code comment stripping (optional)
 * - Whitespace normalization
 *
 * ## Usage
 *
 * ```typescript
 * import { tokenOptimizer } from "./token-optimizer.js";
 *
 * // Optimize a context string
 * const optimized = tokenOptimizer.optimize(context, {
 *   maxTokens: 4000,
 *   preserveCode: true,
 * });
 *
 * // Estimate tokens
 * const tokens = tokenOptimizer.estimateTokens(text);
 * ```
 */

import { createLogger } from "../utils/logger.js";

const logger = createLogger("context:token-optimizer");

/**
 * Optimization configuration
 */
export interface OptimizationConfig {
	/** Maximum tokens for output */
	maxTokens?: number;
	/** Preserve code blocks exactly */
	preserveCode?: boolean;
	/** Strip code comments */
	stripComments?: boolean;
	/** Normalize whitespace */
	normalizeWhitespace?: boolean;
	/** Deduplicate similar content */
	deduplicate?: boolean;
	/** Summarize long outputs */
	summarizeLongOutput?: boolean;
	/** Threshold for "long output" (lines) */
	longOutputThreshold?: number;
	/** Priority sections to preserve (regex patterns) */
	priorityPatterns?: RegExp[];
}

/**
 * Optimization result
 */
export interface OptimizationResult {
	content: string;
	originalTokens: number;
	optimizedTokens: number;
	reductionPercent: number;
	techniques: string[];
}

/**
 * Default priority patterns (content to preserve)
 */
const DEFAULT_PRIORITY_PATTERNS = [
	/error/i,
	/exception/i,
	/failed/i,
	/warning/i,
	/critical/i,
	/TODO/,
	/FIXME/,
	/HACK/,
	/^\s*export\s/m,
	/^\s*import\s/m,
	/^\s*class\s/m,
	/^\s*interface\s/m,
	/^\s*function\s/m,
	/^\s*const\s.*=/m,
];

/**
 * Code comment patterns by language
 */
const COMMENT_PATTERNS: Record<string, RegExp[]> = {
	javascript: [
		/\/\/[^\n]*/g,
		/\/\*[\s\S]*?\*\//g,
	],
	python: [
		/#[^\n]*/g,
		/'''[\s\S]*?'''/g,
		/"""[\s\S]*?"""/g,
	],
	html: [
		/<!--[\s\S]*?-->/g,
	],
	css: [
		/\/\*[\s\S]*?\*\//g,
	],
};

/**
 * Estimate tokens for text (rough approximation)
 */
function estimateTokens(text: string): number {
	// GPT-style tokenization: roughly 4 chars per token for English
	// Code tends to be denser, so we use a slightly lower ratio
	return Math.ceil(text.length / 3.5);
}

/**
 * Detect language from content
 */
function detectLanguage(content: string): string {
	if (content.includes("import ") || content.includes("export ")) {
		return "javascript";
	}
	if (content.includes("def ") || content.includes("import ")) {
		return "python";
	}
	if (content.includes("<!DOCTYPE") || content.includes("<html")) {
		return "html";
	}
	if (content.includes("{") && content.includes(":") && content.includes(";")) {
		return "css";
	}
	return "unknown";
}

/**
 * Strip comments from code
 */
function stripComments(content: string, language: string): string {
	const patterns = COMMENT_PATTERNS[language];
	if (!patterns) return content;

	let result = content;
	for (const pattern of patterns) {
		result = result.replace(pattern, "");
	}
	return result;
}

/**
 * Normalize whitespace
 */
function normalizeWhitespace(content: string): string {
	return content
		// Collapse multiple blank lines to single
		.replace(/\n{3,}/g, "\n\n")
		// Remove trailing whitespace
		.replace(/[ \t]+$/gm, "")
		// Collapse multiple spaces (but preserve indentation)
		.replace(/([^\n])[ \t]{2,}/g, "$1 ");
}

/**
 * Find and deduplicate similar content blocks
 */
function deduplicateContent(content: string): { content: string; removed: number } {
	const lines = content.split("\n");
	const seen = new Map<string, number>();
	const result: string[] = [];
	let removed = 0;

	for (const line of lines) {
		const normalized = line.trim();
		if (normalized.length === 0) {
			result.push(line);
			continue;
		}

		const count = seen.get(normalized) || 0;
		if (count >= 2) {
			// Skip if we've seen this exact line more than twice
			removed++;
			continue;
		}

		seen.set(normalized, count + 1);
		result.push(line);
	}

	return { content: result.join("\n"), removed };
}

/**
 * Summarize long output while preserving important lines
 */
function summarizeLongOutput(
	content: string,
	threshold: number,
	priorityPatterns: RegExp[],
): string {
	const lines = content.split("\n");
	if (lines.length <= threshold) {
		return content;
	}

	const headCount = Math.floor(threshold * 0.3);
	const tailCount = Math.floor(threshold * 0.4);
	const middleCount = threshold - headCount - tailCount;

	const head = lines.slice(0, headCount);
	const tail = lines.slice(-tailCount);
	const middle = lines.slice(headCount, -tailCount);

	// Extract important lines from middle
	const importantLines: string[] = [];
	for (const line of middle) {
		if (priorityPatterns.some((p) => p.test(line))) {
			importantLines.push(line);
			if (importantLines.length >= middleCount) break;
		}
	}

	const truncatedCount = middle.length - importantLines.length;

	return [
		...head,
		"",
		`... [${truncatedCount} lines omitted] ...`,
		"",
		...importantLines,
		"",
		`... [continuing to tail] ...`,
		"",
		...tail,
	].join("\n");
}

/**
 * Extract code blocks from markdown
 */
function extractCodeBlocks(content: string): Array<{ start: number; end: number; content: string }> {
	const blocks: Array<{ start: number; end: number; content: string }> = [];
	const regex = /```[\s\S]*?```/g;
	let match;

	while ((match = regex.exec(content)) !== null) {
		blocks.push({
			start: match.index,
			end: match.index + match[0].length,
			content: match[0],
		});
	}

	return blocks;
}

/**
 * Token optimizer class
 */
class TokenOptimizer {
	private defaultConfig: OptimizationConfig = {
		preserveCode: true,
		stripComments: false,
		normalizeWhitespace: true,
		deduplicate: true,
		summarizeLongOutput: true,
		longOutputThreshold: 100,
		priorityPatterns: DEFAULT_PRIORITY_PATTERNS,
	};

	/**
	 * Estimate tokens for text
	 */
	estimateTokens(text: string): number {
		return estimateTokens(text);
	}

	/**
	 * Optimize content to reduce token usage
	 */
	optimize(content: string, config?: OptimizationConfig): OptimizationResult {
		const cfg = { ...this.defaultConfig, ...config };
		const techniques: string[] = [];
		let result = content;
		const originalTokens = estimateTokens(content);

		// Extract code blocks if preserving
		let codeBlocks: Array<{ start: number; end: number; content: string }> = [];
		if (cfg.preserveCode) {
			codeBlocks = extractCodeBlocks(content);
			// Replace code blocks with placeholders
			for (let i = codeBlocks.length - 1; i >= 0; i--) {
				const block = codeBlocks[i]!;
				result = result.slice(0, block.start) +
					`__CODE_BLOCK_${i}__` +
					result.slice(block.end);
			}
		}

		// Strip comments if enabled
		if (cfg.stripComments && !cfg.preserveCode) {
			const language = detectLanguage(result);
			const before = result.length;
			result = stripComments(result, language);
			if (result.length < before) {
				techniques.push("comment-stripping");
			}
		}

		// Normalize whitespace
		if (cfg.normalizeWhitespace) {
			const before = result.length;
			result = normalizeWhitespace(result);
			if (result.length < before) {
				techniques.push("whitespace-normalization");
			}
		}

		// Deduplicate content
		if (cfg.deduplicate) {
			const { content: deduped, removed } = deduplicateContent(result);
			if (removed > 0) {
				result = deduped;
				techniques.push(`deduplication (${removed} lines)`);
			}
		}

		// Summarize long output
		if (cfg.summarizeLongOutput) {
			const threshold = cfg.longOutputThreshold || 100;
			const linesBefore = result.split("\n").length;
			if (linesBefore > threshold) {
				result = summarizeLongOutput(
					result,
					threshold,
					cfg.priorityPatterns || DEFAULT_PRIORITY_PATTERNS,
				);
				techniques.push("long-output-summarization");
			}
		}

		// Restore code blocks
		if (cfg.preserveCode) {
			for (let i = 0; i < codeBlocks.length; i++) {
				const block = codeBlocks[i]!;
				result = result.replace(`__CODE_BLOCK_${i}__`, block.content);
			}
		}

		// Truncate to max tokens if specified
		if (cfg.maxTokens) {
			const tokens = estimateTokens(result);
			if (tokens > cfg.maxTokens) {
				const ratio = cfg.maxTokens / tokens;
				const targetLength = Math.floor(result.length * ratio * 0.95);
				result = this.smartTruncate(result, targetLength, cfg.priorityPatterns || []);
				techniques.push("smart-truncation");
			}
		}

		const optimizedTokens = estimateTokens(result);
		const reductionPercent = originalTokens > 0
			? Math.round((1 - optimizedTokens / originalTokens) * 100)
			: 0;

		if (techniques.length > 0) {
			logger.debug("Content optimized", {
				originalTokens,
				optimizedTokens,
				reductionPercent,
				techniques,
			});
		}

		return {
			content: result,
			originalTokens,
			optimizedTokens,
			reductionPercent,
			techniques,
		};
	}

	/**
	 * Smart truncation preserving important content
	 */
	private smartTruncate(
		content: string,
		targetLength: number,
		priorityPatterns: RegExp[],
	): string {
		if (content.length <= targetLength) {
			return content;
		}

		const lines = content.split("\n");
		const priorityLines: Array<{ index: number; line: string }> = [];
		const normalLines: Array<{ index: number; line: string }> = [];

		// Classify lines
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;
			const isPriority = priorityPatterns.some((p) => p.test(line));
			if (isPriority) {
				priorityLines.push({ index: i, line });
			} else {
				normalLines.push({ index: i, line });
			}
		}

		// Start with all priority lines
		let result = priorityLines.map((l) => l.line).join("\n");

		// Add normal lines from head and tail until we hit limit
		const headLines: string[] = [];
		const tailLines: string[] = [];
		let currentLength = result.length;

		for (const { line } of normalLines) {
			if (currentLength + line.length + 1 < targetLength * 0.8) {
				headLines.push(line);
				currentLength += line.length + 1;
			} else {
				break;
			}
		}

		for (let i = normalLines.length - 1; i >= 0; i--) {
			const { line } = normalLines[i]!;
			if (currentLength + line.length + 1 < targetLength) {
				tailLines.unshift(line);
				currentLength += line.length + 1;
			} else {
				break;
			}
		}

		return [
			...headLines,
			"",
			"... [content truncated to fit token limit] ...",
			"",
			...priorityLines.map((l) => l.line),
			"",
			...tailLines,
		].join("\n");
	}

	/**
	 * Optimize multiple content blocks
	 */
	optimizeBatch(
		contents: string[],
		totalMaxTokens: number,
		config?: OptimizationConfig,
	): string[] {
		const tokensPerContent = Math.floor(totalMaxTokens / contents.length);

		return contents.map((content) =>
			this.optimize(content, {
				...config,
				maxTokens: tokensPerContent,
			}).content,
		);
	}

	/**
	 * Calculate compression stats
	 */
	getCompressionStats(original: string, optimized: string): {
		originalTokens: number;
		optimizedTokens: number;
		savedTokens: number;
		compressionRatio: number;
	} {
		const originalTokens = estimateTokens(original);
		const optimizedTokens = estimateTokens(optimized);

		return {
			originalTokens,
			optimizedTokens,
			savedTokens: originalTokens - optimizedTokens,
			compressionRatio: originalTokens > 0 ? optimizedTokens / originalTokens : 1,
		};
	}
}

/**
 * Global token optimizer instance
 */
export const tokenOptimizer = new TokenOptimizer();

/**
 * Quick function to optimize content
 */
export function optimizeTokens(
	content: string,
	maxTokens?: number,
): string {
	return tokenOptimizer.optimize(content, { maxTokens }).content;
}
