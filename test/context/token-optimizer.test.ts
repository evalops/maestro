/**
 * Token Optimizer Tests
 *
 * Tests the token optimization utilities for reducing prompt sizes
 * through deduplication, summarization, and smart truncation.
 */

import { describe, expect, it, vi } from "vitest";
import {
	optimizeTokens,
	tokenOptimizer,
} from "../../src/context/token-optimizer.js";

// Mock the logger
vi.mock("../../src/utils/logger.js", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

describe("TokenOptimizer", () => {
	describe("estimateTokens", () => {
		it("estimates tokens for empty string", () => {
			expect(tokenOptimizer.estimateTokens("")).toBe(0);
		});

		it("estimates tokens for short text", () => {
			const text = "Hello, world!";
			const tokens = tokenOptimizer.estimateTokens(text);
			// ~13 chars / 3.5 = ~4 tokens
			expect(tokens).toBeGreaterThan(0);
			expect(tokens).toBeLessThan(10);
		});

		it("estimates tokens for longer text", () => {
			const text = "The quick brown fox jumps over the lazy dog. ".repeat(10);
			const tokens = tokenOptimizer.estimateTokens(text);
			// ~450 chars / 3.5 = ~129 tokens
			expect(tokens).toBeGreaterThan(100);
			expect(tokens).toBeLessThan(200);
		});

		it("estimates tokens for code content", () => {
			const code = `
function calculateSum(arr: number[]): number {
	return arr.reduce((sum, n) => sum + n, 0);
}
`;
			const tokens = tokenOptimizer.estimateTokens(code);
			expect(tokens).toBeGreaterThan(0);
		});
	});

	describe("optimize", () => {
		describe("basic optimization", () => {
			it("returns original content when no optimization needed", () => {
				const content = "Hello, world!";
				const result = tokenOptimizer.optimize(content, {
					normalizeWhitespace: false,
					deduplicate: false,
					summarizeLongOutput: false,
				});

				expect(result.content).toBe(content);
				expect(result.techniques).toHaveLength(0);
				expect(result.reductionPercent).toBe(0);
			});

			it("tracks original and optimized token counts", () => {
				const content = "Line 1\n\n\n\nLine 2";
				const result = tokenOptimizer.optimize(content);

				expect(result.originalTokens).toBeGreaterThan(0);
				expect(result.optimizedTokens).toBeGreaterThan(0);
				expect(result.originalTokens).toBeGreaterThanOrEqual(
					result.optimizedTokens,
				);
			});
		});

		describe("whitespace normalization", () => {
			it("collapses multiple blank lines", () => {
				const content = "Line 1\n\n\n\n\nLine 2";
				const result = tokenOptimizer.optimize(content, {
					normalizeWhitespace: true,
				});

				expect(result.content).toBe("Line 1\n\nLine 2");
				expect(result.techniques).toContain("whitespace-normalization");
			});

			it("removes trailing whitespace", () => {
				const content = "Line 1   \nLine 2\t\t\t";
				const result = tokenOptimizer.optimize(content, {
					normalizeWhitespace: true,
				});

				expect(result.content).toBe("Line 1\nLine 2");
			});

			it("collapses multiple spaces within lines", () => {
				const content = "Word1    Word2     Word3";
				const result = tokenOptimizer.optimize(content, {
					normalizeWhitespace: true,
				});

				expect(result.content).toBe("Word1 Word2 Word3");
			});

			it("preserves indentation", () => {
				const content = "function test() {\n\t\treturn true;\n}";
				const result = tokenOptimizer.optimize(content, {
					normalizeWhitespace: true,
				});

				// Indentation should be preserved
				expect(result.content).toContain("\t\treturn true;");
			});
		});

		describe("deduplication", () => {
			it("removes lines appearing more than twice", () => {
				const content = "A\nB\nA\nA\nA\nB\nB\nB";
				const result = tokenOptimizer.optimize(content, {
					deduplicate: true,
					normalizeWhitespace: false,
				});

				// A appears 4 times, keep first 2; B appears 4 times, keep first 2
				const lines = result.content.split("\n").filter((l) => l);
				const aCount = lines.filter((l) => l === "A").length;
				const bCount = lines.filter((l) => l === "B").length;

				expect(aCount).toBe(2);
				expect(bCount).toBe(2);
				expect(result.techniques).toContainEqual(
					expect.stringContaining("deduplication"),
				);
			});

			it("preserves empty lines", () => {
				const content = "A\n\nB\n\nC";
				const result = tokenOptimizer.optimize(content, {
					deduplicate: true,
					normalizeWhitespace: false,
				});

				expect(result.content.split("\n").length).toBe(5);
			});

			it("handles unique content without changes", () => {
				const content = "Line 1\nLine 2\nLine 3";
				const result = tokenOptimizer.optimize(content, {
					deduplicate: true,
					normalizeWhitespace: false,
				});

				expect(result.content).toBe(content);
			});
		});

		describe("long output summarization", () => {
			it("summarizes content exceeding threshold", () => {
				const lines = Array.from({ length: 150 }, (_, i) => `Line ${i + 1}`);
				const content = lines.join("\n");

				const result = tokenOptimizer.optimize(content, {
					summarizeLongOutput: true,
					longOutputThreshold: 100,
					normalizeWhitespace: false,
					deduplicate: false,
				});

				expect(result.content).toContain("[");
				expect(result.content).toContain("lines omitted");
				expect(result.techniques).toContain("long-output-summarization");
			});

			it("does not summarize content under threshold", () => {
				const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`);
				const content = lines.join("\n");

				const result = tokenOptimizer.optimize(content, {
					summarizeLongOutput: true,
					longOutputThreshold: 100,
				});

				expect(result.content).not.toContain("lines omitted");
			});

			it("preserves priority lines during summarization", () => {
				const lines = [
					...Array.from({ length: 50 }, (_, i) => `Normal ${i}`),
					"ERROR: Something went wrong",
					...Array.from({ length: 100 }, (_, i) => `More normal ${i}`),
				];
				const content = lines.join("\n");

				const result = tokenOptimizer.optimize(content, {
					summarizeLongOutput: true,
					longOutputThreshold: 50,
					priorityPatterns: [/error/i],
				});

				expect(result.content).toContain("ERROR: Something went wrong");
			});
		});

		describe("code block preservation", () => {
			it("preserves code blocks when preserveCode is true", () => {
				const content = `
Some text

\`\`\`typescript
function test() {
	return true;
}
\`\`\`

More text
`;
				const result = tokenOptimizer.optimize(content, {
					preserveCode: true,
					normalizeWhitespace: true,
				});

				expect(result.content).toContain("```typescript");
				expect(result.content).toContain("function test()");
				expect(result.content).toContain("```");
			});

			it("handles multiple code blocks", () => {
				const content = `
\`\`\`js
const a = 1;
\`\`\`

\`\`\`python
x = 2
\`\`\`
`;
				const result = tokenOptimizer.optimize(content, {
					preserveCode: true,
				});

				expect(result.content).toContain("const a = 1");
				expect(result.content).toContain("x = 2");
			});
		});

		describe("comment stripping", () => {
			it("strips JavaScript comments when enabled", () => {
				// Content must contain import/export for JS language detection
				const content = `
import { foo } from 'bar';
// Single line comment
const x = 1; // inline comment
/* Multi
   line
   comment */
const y = 2;
export default x;
`;
				const result = tokenOptimizer.optimize(content, {
					stripComments: true,
					preserveCode: false,
					normalizeWhitespace: true,
				});

				expect(result.content).not.toContain("Single line comment");
				expect(result.content).not.toContain("inline comment");
				expect(result.content).not.toContain("Multi");
				expect(result.content).toContain("const x = 1");
				expect(result.content).toContain("const y = 2");
				expect(result.content).toContain("import { foo }");
				expect(result.techniques).toContain("comment-stripping");
			});

			it("strips Python comments", () => {
				const content = `
def foo():
    # Python comment
    x = 1
`;
				const result = tokenOptimizer.optimize(content, {
					stripComments: true,
					preserveCode: false,
				});

				expect(result.content).not.toContain("Python comment");
				expect(result.content).toContain("def foo()");
			});

			it("does not strip comments when preserveCode is true", () => {
				const content = "// comment\nconst x = 1;";

				const result = tokenOptimizer.optimize(content, {
					stripComments: true,
					preserveCode: true,
				});

				// preserveCode takes precedence
				expect(result.techniques).not.toContain("comment-stripping");
			});
		});

		describe("max tokens truncation", () => {
			it("truncates content exceeding max tokens", () => {
				const longContent = "Word ".repeat(1000);
				const result = tokenOptimizer.optimize(longContent, {
					maxTokens: 100,
				});

				expect(
					tokenOptimizer.estimateTokens(result.content),
				).toBeLessThanOrEqual(120); // Allow some margin
				expect(result.techniques).toContain("smart-truncation");
			});

			it("preserves priority content during truncation", () => {
				const content = [
					...Array.from({ length: 50 }, (_, i) => `Normal line ${i}`),
					"ERROR: Critical error occurred",
					...Array.from({ length: 50 }, (_, i) => `More normal ${i}`),
				].join("\n");

				const result = tokenOptimizer.optimize(content, {
					maxTokens: 100,
					priorityPatterns: [/error/i],
				});

				expect(result.content).toContain("ERROR: Critical error occurred");
			});

			it("does not truncate when under max tokens", () => {
				const content = "Short content";
				const result = tokenOptimizer.optimize(content, {
					maxTokens: 1000,
				});

				expect(result.content).toBe("Short content");
				expect(result.techniques).not.toContain("smart-truncation");
			});
		});

		describe("combined optimizations", () => {
			it("applies multiple techniques", () => {
				const content = `
Line 1


Line 2
Line 2
Line 2
Line 2

  Extra   spaces   here
`;
				const result = tokenOptimizer.optimize(content, {
					normalizeWhitespace: true,
					deduplicate: true,
				});

				expect(result.techniques).toContain("whitespace-normalization");
				expect(result.techniques).toContainEqual(
					expect.stringContaining("deduplication"),
				);
				expect(result.reductionPercent).toBeGreaterThan(0);
			});
		});
	});

	describe("optimizeBatch", () => {
		it("optimizes multiple content blocks", () => {
			const contents = [
				"Content A\n\n\n\nwith spaces",
				"Content B\n\n\n\nwith spaces",
				"Content C\n\n\n\nwith spaces",
			];

			const results = tokenOptimizer.optimizeBatch(contents, 1000);

			expect(results).toHaveLength(3);
			for (const result of results) {
				expect(result).toContain("Content");
				// Whitespace should be normalized
				expect(result).not.toMatch(/\n{4,}/);
			}
		});

		it("distributes max tokens across contents", () => {
			const longContent = "Word ".repeat(500);
			const contents = [longContent, longContent, longContent];

			const results = tokenOptimizer.optimizeBatch(contents, 300);

			// Each should get roughly 100 tokens
			for (const result of results) {
				const tokens = tokenOptimizer.estimateTokens(result);
				expect(tokens).toBeLessThan(150); // Allow some margin
			}
		});

		it("handles empty array", () => {
			const results = tokenOptimizer.optimizeBatch([], 1000);
			expect(results).toEqual([]);
		});
	});

	describe("getCompressionStats", () => {
		it("calculates compression stats correctly", () => {
			const original = "Word ".repeat(100);
			const optimized = "Word ".repeat(50);

			const stats = tokenOptimizer.getCompressionStats(original, optimized);

			expect(stats.originalTokens).toBeGreaterThan(stats.optimizedTokens);
			expect(stats.savedTokens).toBe(
				stats.originalTokens - stats.optimizedTokens,
			);
			expect(stats.compressionRatio).toBeCloseTo(0.5, 1);
		});

		it("handles empty original", () => {
			const stats = tokenOptimizer.getCompressionStats("", "");

			expect(stats.originalTokens).toBe(0);
			expect(stats.optimizedTokens).toBe(0);
			expect(stats.savedTokens).toBe(0);
			expect(stats.compressionRatio).toBe(1);
		});

		it("handles no compression", () => {
			const content = "Same content";
			const stats = tokenOptimizer.getCompressionStats(content, content);

			expect(stats.savedTokens).toBe(0);
			expect(stats.compressionRatio).toBe(1);
		});
	});

	describe("optimizeTokens helper", () => {
		it("returns optimized content string", () => {
			const content = "Hello\n\n\n\nWorld";
			const result = optimizeTokens(content);

			expect(result).toBe("Hello\n\nWorld");
		});

		it("respects maxTokens parameter", () => {
			const longContent = "Word ".repeat(500);
			const result = optimizeTokens(longContent, 50);

			const tokens = tokenOptimizer.estimateTokens(result);
			expect(tokens).toBeLessThan(75);
		});

		it("returns content as-is when no optimization needed", () => {
			const content = "Short";
			const result = optimizeTokens(content);

			expect(result).toBe("Short");
		});
	});

	describe("priority patterns", () => {
		it("uses default priority patterns", () => {
			const lines = [
				...Array.from({ length: 50 }, () => "normal line"),
				"ERROR: Something failed",
				"TODO: Fix this later",
				"export function main() {}",
				...Array.from({ length: 50 }, () => "more normal"),
			];
			const content = lines.join("\n");

			const result = tokenOptimizer.optimize(content, {
				maxTokens: 50,
			});

			// Default patterns should preserve error, TODO, export
			expect(result.content).toContain("ERROR:");
		});

		it("uses custom priority patterns", () => {
			const lines = [
				...Array.from({ length: 50 }, () => "normal line"),
				"CUSTOM_MARKER: Important",
				...Array.from({ length: 50 }, () => "more normal"),
			];
			const content = lines.join("\n");

			const result = tokenOptimizer.optimize(content, {
				maxTokens: 50,
				priorityPatterns: [/CUSTOM_MARKER/],
			});

			expect(result.content).toContain("CUSTOM_MARKER: Important");
		});
	});

	describe("edge cases", () => {
		it("handles content with only whitespace", () => {
			const content = "   \n\n\t\t\n   ";
			const result = tokenOptimizer.optimize(content);

			expect(result.optimizedTokens).toBeLessThanOrEqual(result.originalTokens);
		});

		it("handles content with unicode", () => {
			const content = "Hello 🌍 World 你好 مرحبا";
			const result = tokenOptimizer.optimize(content);

			expect(result.content).toContain("🌍");
			expect(result.content).toContain("你好");
			expect(result.content).toContain("مرحبا");
		});

		it("handles very long lines", () => {
			const longLine = "x".repeat(10000);
			const result = tokenOptimizer.optimize(longLine);

			expect(result.content.length).toBeGreaterThan(0);
		});

		it("handles mixed line endings", () => {
			const content = "Line1\r\nLine2\nLine3\rLine4";
			const result = tokenOptimizer.optimize(content);

			expect(result.content).toBeDefined();
		});

		it("handles content with special regex characters", () => {
			const content = "Match: [a-z]+ and (group) with $1 replacement";
			const result = tokenOptimizer.optimize(content);

			expect(result.content).toContain("[a-z]+");
			expect(result.content).toContain("(group)");
		});
	});

	describe("language detection", () => {
		it("detects JavaScript by import/export", () => {
			const js = "import { foo } from 'bar';";
			const result = tokenOptimizer.optimize(js, {
				stripComments: true,
				preserveCode: false,
			});

			expect(result.content).toContain("import");
		});

		it("detects Python by def keyword", () => {
			const py = "def hello():\n    print('hi')";
			const result = tokenOptimizer.optimize(py, {
				stripComments: true,
				preserveCode: false,
			});

			expect(result.content).toContain("def hello");
		});

		it("detects HTML by DOCTYPE or html tag", () => {
			const html = "<!DOCTYPE html>\n<html><body>Test</body></html>";
			const result = tokenOptimizer.optimize(html, {
				stripComments: true,
				preserveCode: false,
			});

			expect(result.content).toContain("<!DOCTYPE html>");
		});

		it("detects CSS by braces with colons and semicolons", () => {
			const css = ".class { color: red; font-size: 12px; }";
			const result = tokenOptimizer.optimize(css, {
				stripComments: true,
				preserveCode: false,
			});

			expect(result.content).toContain("color: red");
		});
	});

	describe("code block extraction", () => {
		it("correctly restores code blocks after optimization", () => {
			const content = `
Text before

\`\`\`typescript
// This comment should be preserved
function hello() {
	return "world";
}
\`\`\`

Text after with   extra   spaces
`;
			const result = tokenOptimizer.optimize(content, {
				preserveCode: true,
				normalizeWhitespace: true,
			});

			// Code block should be intact
			expect(result.content).toContain("// This comment should be preserved");
			// Text outside should be normalized
			expect(result.content).toContain("Text after with extra spaces");
		});

		it("handles nested backticks in code blocks", () => {
			const content = `
\`\`\`markdown
Here is some \`inline code\` in markdown
\`\`\`
`;
			const result = tokenOptimizer.optimize(content, {
				preserveCode: true,
			});

			expect(result.content).toContain("`inline code`");
		});
	});
});
