/**
 * Repository Map Generator
 *
 * Generates a structural overview of the codebase to provide better context
 * to the model. Inspired by Aider's repo-map feature.
 *
 * ## Features
 *
 * - Extracts file structure with important symbols
 * - Identifies key files (entry points, configs, types)
 * - Ranks files by importance and relevance
 * - Generates concise summaries within token budgets
 *
 * ## Usage
 *
 * ```typescript
 * import { repoMap } from "./repo-map.js";
 *
 * // Generate map for current directory
 * const map = await repoMap.generate({
 *   rootDir: process.cwd(),
 *   maxTokens: 4000,
 *   focusFiles: ["src/main.ts"],
 * });
 *
 * // Get map as context string
 * const context = repoMap.formatForContext(map);
 * ```
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("context:repo-map");

/**
 * Symbol extracted from a file
 */
export interface ExtractedSymbol {
	name: string;
	kind: "class" | "function" | "interface" | "type" | "const" | "export" | "import";
	line: number;
	exported: boolean;
}

/**
 * File entry in the repo map
 */
export interface RepoMapEntry {
	path: string;
	relativePath: string;
	size: number;
	language: string;
	symbols: ExtractedSymbol[];
	importance: number;
	summary?: string;
}

/**
 * Repo map configuration
 */
export interface RepoMapConfig {
	/** Root directory to map */
	rootDir: string;
	/** Maximum tokens for the map */
	maxTokens?: number;
	/** Files to focus on (boost importance) */
	focusFiles?: string[];
	/** File patterns to exclude */
	excludePatterns?: string[];
	/** Include file contents for small files */
	includeContents?: boolean;
	/** Max file size to include contents (bytes) */
	maxContentSize?: number;
}

/**
 * Generated repo map
 */
export interface RepoMap {
	rootDir: string;
	generatedAt: string;
	totalFiles: number;
	entries: RepoMapEntry[];
	summary: string;
}

/**
 * Language detection by extension
 */
const LANGUAGE_MAP: Record<string, string> = {
	".ts": "typescript",
	".tsx": "typescript",
	".js": "javascript",
	".jsx": "javascript",
	".py": "python",
	".rb": "ruby",
	".go": "go",
	".rs": "rust",
	".java": "java",
	".kt": "kotlin",
	".swift": "swift",
	".c": "c",
	".cpp": "cpp",
	".h": "c",
	".hpp": "cpp",
	".cs": "csharp",
	".php": "php",
	".vue": "vue",
	".svelte": "svelte",
	".md": "markdown",
	".json": "json",
	".yaml": "yaml",
	".yml": "yaml",
	".toml": "toml",
	".sql": "sql",
	".sh": "shell",
	".bash": "shell",
};

/**
 * Important file patterns (boost importance score)
 */
const IMPORTANT_PATTERNS = [
	/^(main|index|app|server|cli)\.[jt]sx?$/,
	/^(package|cargo|go\.mod|requirements|Gemfile).*$/,
	/^(tsconfig|webpack|vite|rollup).*\.json$/,
	/^\.env.*$/,
	/^(Dockerfile|docker-compose)/,
	/^(README|CHANGELOG|LICENSE)/i,
	/types?\.[jt]s$/,
	/schema\.[jt]s$/,
	/config\.[jt]s$/,
];

/**
 * Patterns to exclude from mapping
 */
const DEFAULT_EXCLUDE = [
	/node_modules/,
	/\.git/,
	/dist\//,
	/build\//,
	/\.next\//,
	/\.cache/,
	/coverage\//,
	/__pycache__/,
	/\.pyc$/,
	/\.min\.[jt]s$/,
	/\.map$/,
	/\.lock$/,
	/package-lock\.json$/,
	/yarn\.lock$/,
];

/**
 * Extract symbols from TypeScript/JavaScript content
 */
function extractTSSymbols(content: string): ExtractedSymbol[] {
	const symbols: ExtractedSymbol[] = [];
	const lines = content.split("\n");

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] || "";
		const lineNum = i + 1;

		// Classes
		const classMatch = line.match(/^(export\s+)?(class|abstract\s+class)\s+(\w+)/);
		if (classMatch) {
			symbols.push({
				name: classMatch[3]!,
				kind: "class",
				line: lineNum,
				exported: !!classMatch[1],
			});
			continue;
		}

		// Functions
		const funcMatch = line.match(/^(export\s+)?(async\s+)?function\s+(\w+)/);
		if (funcMatch) {
			symbols.push({
				name: funcMatch[3]!,
				kind: "function",
				line: lineNum,
				exported: !!funcMatch[1],
			});
			continue;
		}

		// Arrow functions assigned to const
		const arrowMatch = line.match(/^(export\s+)?const\s+(\w+)\s*=\s*(async\s+)?\(/);
		if (arrowMatch) {
			symbols.push({
				name: arrowMatch[2]!,
				kind: "function",
				line: lineNum,
				exported: !!arrowMatch[1],
			});
			continue;
		}

		// Interfaces
		const interfaceMatch = line.match(/^(export\s+)?interface\s+(\w+)/);
		if (interfaceMatch) {
			symbols.push({
				name: interfaceMatch[2]!,
				kind: "interface",
				line: lineNum,
				exported: !!interfaceMatch[1],
			});
			continue;
		}

		// Types
		const typeMatch = line.match(/^(export\s+)?type\s+(\w+)/);
		if (typeMatch) {
			symbols.push({
				name: typeMatch[2]!,
				kind: "type",
				line: lineNum,
				exported: !!typeMatch[1],
			});
			continue;
		}

		// Exported consts
		const constMatch = line.match(/^export\s+const\s+(\w+)/);
		if (constMatch) {
			symbols.push({
				name: constMatch[1]!,
				kind: "const",
				line: lineNum,
				exported: true,
			});
		}
	}

	return symbols;
}

/**
 * Extract symbols from Python content
 */
function extractPySymbols(content: string): ExtractedSymbol[] {
	const symbols: ExtractedSymbol[] = [];
	const lines = content.split("\n");

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] || "";
		const lineNum = i + 1;

		// Classes
		const classMatch = line.match(/^class\s+(\w+)/);
		if (classMatch) {
			symbols.push({
				name: classMatch[1]!,
				kind: "class",
				line: lineNum,
				exported: !classMatch[1]!.startsWith("_"),
			});
			continue;
		}

		// Functions (top-level only)
		const funcMatch = line.match(/^(async\s+)?def\s+(\w+)/);
		if (funcMatch) {
			symbols.push({
				name: funcMatch[2]!,
				kind: "function",
				line: lineNum,
				exported: !funcMatch[2]!.startsWith("_"),
			});
		}
	}

	return symbols;
}

/**
 * Calculate importance score for a file
 */
function calculateImportance(
	relativePath: string,
	symbols: ExtractedSymbol[],
	focusFiles: string[],
): number {
	let score = 0;
	const filename = basename(relativePath);

	// Check important patterns
	for (const pattern of IMPORTANT_PATTERNS) {
		if (pattern.test(filename)) {
			score += 10;
			break;
		}
	}

	// Focus files get highest priority
	if (focusFiles.some((f) => relativePath.includes(f))) {
		score += 50;
	}

	// Exported symbols increase importance
	const exportedCount = symbols.filter((s) => s.exported).length;
	score += Math.min(exportedCount * 2, 20);

	// Depth penalty (deeper files are less important)
	const depth = relativePath.split("/").length;
	score -= Math.min(depth, 5);

	// Boost for entry-point directories
	if (relativePath.startsWith("src/") || relativePath.startsWith("lib/")) {
		score += 5;
	}

	// Boost for test files (useful context)
	if (relativePath.includes("test") || relativePath.includes("spec")) {
		score += 3;
	}

	return Math.max(score, 0);
}

/**
 * Estimate tokens for a string (rough approximation)
 */
function estimateTokens(text: string): number {
	// Rough estimate: ~4 characters per token
	return Math.ceil(text.length / 4);
}

/**
 * Repo map generator class
 */
class RepoMapGenerator {
	/**
	 * Generate a repo map
	 */
	async generate(config: RepoMapConfig): Promise<RepoMap> {
		const {
			rootDir,
			maxTokens = 4000,
			focusFiles = [],
			excludePatterns = [],
			includeContents = false,
			maxContentSize = 2000,
		} = config;

		const allExclude = [...DEFAULT_EXCLUDE, ...excludePatterns.map((p) => new RegExp(p))];
		const entries: RepoMapEntry[] = [];

		// Recursively scan directory
		const scanDir = (dir: string): void => {
			try {
				const items = readdirSync(dir);

				for (const item of items) {
					const fullPath = join(dir, item);
					const relativePath = relative(rootDir, fullPath);

					// Check exclusions
					if (allExclude.some((pattern) => pattern.test(relativePath))) {
						continue;
					}

					try {
						const stat = statSync(fullPath);

						if (stat.isDirectory()) {
							scanDir(fullPath);
						} else if (stat.isFile()) {
							const ext = extname(item);
							const language = LANGUAGE_MAP[ext];

							if (!language) continue;

							const content = readFileSync(fullPath, "utf-8");
							let symbols: ExtractedSymbol[] = [];

							// Extract symbols based on language
							if (language === "typescript" || language === "javascript") {
								symbols = extractTSSymbols(content);
							} else if (language === "python") {
								symbols = extractPySymbols(content);
							}

							const importance = calculateImportance(relativePath, symbols, focusFiles);

							const entry: RepoMapEntry = {
								path: fullPath,
								relativePath,
								size: stat.size,
								language,
								symbols,
								importance,
							};

							// Include contents for small, important files
							if (includeContents && stat.size <= maxContentSize && importance > 10) {
								entry.summary = content.slice(0, maxContentSize);
							}

							entries.push(entry);
						}
					} catch {
						// Skip files we can't read
					}
				}
			} catch {
				// Skip directories we can't read
			}
		};

		scanDir(rootDir);

		// Sort by importance
		entries.sort((a, b) => b.importance - a.importance);

		// Truncate to fit token budget
		let totalTokens = 0;
		const truncatedEntries: RepoMapEntry[] = [];

		for (const entry of entries) {
			const entryTokens = this.estimateEntryTokens(entry);
			if (totalTokens + entryTokens > maxTokens) {
				break;
			}
			truncatedEntries.push(entry);
			totalTokens += entryTokens;
		}

		const map: RepoMap = {
			rootDir,
			generatedAt: new Date().toISOString(),
			totalFiles: entries.length,
			entries: truncatedEntries,
			summary: this.generateSummary(truncatedEntries, entries.length),
		};

		logger.info("Repo map generated", {
			totalFiles: entries.length,
			includedFiles: truncatedEntries.length,
			estimatedTokens: totalTokens,
		});

		return map;
	}

	/**
	 * Estimate tokens for an entry
	 */
	private estimateEntryTokens(entry: RepoMapEntry): number {
		let text = entry.relativePath;
		text += entry.symbols.map((s) => `${s.kind} ${s.name}`).join(" ");
		if (entry.summary) {
			text += entry.summary;
		}
		return estimateTokens(text);
	}

	/**
	 * Generate summary text
	 */
	private generateSummary(entries: RepoMapEntry[], totalFiles: number): string {
		const languages = new Map<string, number>();
		let totalSymbols = 0;

		for (const entry of entries) {
			languages.set(entry.language, (languages.get(entry.language) || 0) + 1);
			totalSymbols += entry.symbols.length;
		}

		const langSummary = Array.from(languages.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5)
			.map(([lang, count]) => `${lang}: ${count}`)
			.join(", ");

		return `${entries.length}/${totalFiles} files mapped, ${totalSymbols} symbols. Languages: ${langSummary}`;
	}

	/**
	 * Format repo map for use as context
	 */
	formatForContext(map: RepoMap): string {
		const lines: string[] = [
			"## Repository Structure",
			"",
			map.summary,
			"",
			"### Key Files",
			"",
		];

		// Group by directory
		const byDir = new Map<string, RepoMapEntry[]>();
		for (const entry of map.entries) {
			const dir = entry.relativePath.split("/").slice(0, -1).join("/") || ".";
			if (!byDir.has(dir)) {
				byDir.set(dir, []);
			}
			byDir.get(dir)!.push(entry);
		}

		for (const [dir, files] of Array.from(byDir)) {
			lines.push(`**${dir}/**`);
			for (const file of files) {
				const filename = basename(file.relativePath);
				const exportedSymbols = file.symbols
					.filter((s) => s.exported)
					.slice(0, 5)
					.map((s) => s.name);

				if (exportedSymbols.length > 0) {
					lines.push(`- ${filename}: ${exportedSymbols.join(", ")}`);
				} else {
					lines.push(`- ${filename}`);
				}
			}
			lines.push("");
		}

		return lines.join("\n");
	}

	/**
	 * Get relevant files for a query
	 */
	getRelevantFiles(map: RepoMap, query: string): RepoMapEntry[] {
		const queryLower = query.toLowerCase();
		const terms = queryLower.split(/\s+/);

		return map.entries
			.filter((entry) => {
				const searchText = [
					entry.relativePath,
					...entry.symbols.map((s) => s.name),
				].join(" ").toLowerCase();

				return terms.some((term) => searchText.includes(term));
			})
			.slice(0, 10);
	}
}

/**
 * Global repo map generator instance
 */
export const repoMap = new RepoMapGenerator();

/**
 * Quick function to generate context for a directory
 */
export async function generateRepoContext(
	rootDir: string,
	focusFiles?: string[],
	maxTokens = 4000,
): Promise<string> {
	const map = await repoMap.generate({
		rootDir,
		focusFiles,
		maxTokens,
	});
	return repoMap.formatForContext(map);
}
