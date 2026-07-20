import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	delimiter as pathDelimiter,
} from "node:path";
import type { AutocompleteItem, AutocompleteProvider } from "@evalops/tui";
import {
	expandTildePathWithHomeDir,
	getHomeDir,
} from "../../utils/path-expansion.js";

/**
 * Common shell builtins that should appear in command completion.
 */
const SHELL_BUILTINS = [
	"cd",
	"pwd",
	"echo",
	"export",
	"unset",
	"source",
	"alias",
	"history",
	"exit",
	"which",
	"type",
];

/**
 * Git subcommands for git completion.
 */
const GIT_SUBCOMMANDS = [
	"add",
	"branch",
	"checkout",
	"clone",
	"commit",
	"diff",
	"fetch",
	"init",
	"log",
	"merge",
	"pull",
	"push",
	"rebase",
	"reset",
	"restore",
	"stash",
	"status",
	"switch",
	"tag",
];

/**
 * Enhanced autocomplete provider for bash mode.
 * Provides completions for:
 * - Executables from PATH
 * - Git subcommands
 * - NPM scripts
 * - File paths
 * - History-based suggestions
 */
export class BashAutocompleteProvider implements AutocompleteProvider {
	private basePath: string;
	private history: string[];
	private executableCache: Map<string, string[]> = new Map();
	private npmScriptsCache: { scripts: string[]; ts: number } | null = null;
	private readonly cacheTtlMs = 30_000;

	constructor(basePath: string = process.cwd(), history: string[] = []) {
		this.basePath = basePath;
		this.history = history;
	}

	setBasePath(basePath: string): void {
		this.basePath = basePath;
		this.npmScriptsCache = null; // Invalidate npm scripts cache on cwd change
	}

	setHistory(history: string[]): void {
		this.history = history;
	}

	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): { items: AutocompleteItem[]; prefix: string } | null {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		// Check for git subcommand completion
		const gitMatch = textBeforeCursor.match(/^git\s+(\S*)$/);
		if (gitMatch) {
			const prefix = gitMatch[1]!;
			const items = this.getGitSubcommandSuggestions(prefix);
			if (items.length > 0) {
				return { items, prefix };
			}
		}

		// Check for npm run completion
		const npmMatch = textBeforeCursor.match(/^npm\s+run\s+(\S*)$/);
		if (npmMatch) {
			const prefix = npmMatch[1]!;
			const items = this.getNpmScriptSuggestions(prefix);
			if (items.length > 0) {
				return { items, prefix };
			}
		}

		// Check for bun run completion
		const bunMatch = textBeforeCursor.match(/^bun\s+run\s+(\S*)$/);
		if (bunMatch) {
			const prefix = bunMatch[1]!;
			const items = this.getNpmScriptSuggestions(prefix);
			if (items.length > 0) {
				return { items, prefix };
			}
		}

		// Check for command completion (first word)
		const firstWordMatch = textBeforeCursor.match(/^(\S*)$/);
		if (firstWordMatch) {
			const prefix = firstWordMatch[1]!;
			const items = this.getCommandSuggestions(prefix);
			if (items.length > 0) {
				return { items, prefix };
			}
		}

		// Check for file path completion (after first word)
		const pathMatch = this.extractPathPrefix(textBeforeCursor);
		if (pathMatch !== null) {
			const items = this.getFileSuggestions(pathMatch);
			if (items.length > 0) {
				return { items, prefix: pathMatch };
			}
		}

		return null;
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const currentLine = lines[cursorLine] || "";
		const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
		const afterCursor = currentLine.slice(cursorCol);

		// Add trailing space for commands, but not for directory paths
		const isDirectory = item.description === "directory";
		const suffix = isDirectory ? "" : " ";
		const newLine = beforePrefix + item.value + suffix + afterCursor;
		const newLines = [...lines];
		newLines[cursorLine] = newLine;

		return {
			lines: newLines,
			cursorLine,
			cursorCol: beforePrefix.length + item.value.length + suffix.length,
		};
	}

	private getCommandSuggestions(prefix: string): AutocompleteItem[] {
		const items: AutocompleteItem[] = [];
		const seen = new Set<string>();
		const lowerPrefix = prefix.toLowerCase();

		// Add matching shell builtins
		for (const builtin of SHELL_BUILTINS) {
			if (builtin.startsWith(lowerPrefix) && !seen.has(builtin)) {
				seen.add(builtin);
				items.push({
					value: builtin,
					label: builtin,
					description: "builtin",
				});
			}
		}

		// Add matching executables from PATH
		const executables = this.getExecutablesFromPath();
		for (const exe of executables) {
			if (exe.toLowerCase().startsWith(lowerPrefix) && !seen.has(exe)) {
				seen.add(exe);
				items.push({
					value: exe,
					label: exe,
					description: "command",
				});
			}
		}

		// Add fuzzy matches from history
		const historyMatches = this.getFuzzyHistoryMatches(prefix);
		for (const match of historyMatches) {
			const firstWord = match.split(/\s+/)[0];
			if (firstWord && !seen.has(match)) {
				seen.add(match);
				items.push({
					value: match,
					label: match.length > 40 ? `${match.slice(0, 37)}...` : match,
					description: "history",
				});
			}
		}

		return items.slice(0, 15);
	}

	private getGitSubcommandSuggestions(prefix: string): AutocompleteItem[] {
		const lowerPrefix = prefix.toLowerCase();
		return GIT_SUBCOMMANDS.filter((cmd) => cmd.startsWith(lowerPrefix)).map(
			(cmd) => ({
				value: cmd,
				label: cmd,
				description: "git",
			}),
		);
	}

	private getNpmScriptSuggestions(prefix: string): AutocompleteItem[] {
		const scripts = this.getNpmScripts();
		const lowerPrefix = prefix.toLowerCase();
		return scripts
			.filter((script) => script.toLowerCase().startsWith(lowerPrefix))
			.map((script) => ({
				value: script,
				label: script,
				description: "script",
			}))
			.slice(0, 15);
	}

	private getNpmScripts(): string[] {
		const now = Date.now();
		if (
			this.npmScriptsCache &&
			now - this.npmScriptsCache.ts < this.cacheTtlMs
		) {
			return this.npmScriptsCache.scripts;
		}

		const scripts: string[] = [];
		const packageJsonPath = join(this.basePath, "package.json");

		try {
			if (existsSync(packageJsonPath)) {
				const raw = readFileSync(packageJsonPath, "utf-8");
				const pkg = JSON.parse(raw);
				if (pkg.scripts && typeof pkg.scripts === "object") {
					scripts.push(...Object.keys(pkg.scripts));
				}
			}
		} catch {
			// Ignore errors
		}

		this.npmScriptsCache = { scripts, ts: now };
		return scripts;
	}

	private getExecutablesFromPath(): string[] {
		const pathEnv = process.env.PATH || "";
		const cacheKey = pathEnv;

		const cached = this.executableCache.get(cacheKey);
		if (cached) {
			return cached;
		}

		const executables = new Set<string>();
		const pathDirs = pathEnv.split(pathDelimiter || ":");

		for (const dir of pathDirs.slice(0, 10)) {
			// Limit to first 10 PATH entries
			try {
				if (!existsSync(dir)) continue;
				const entries = readdirSync(dir);
				for (const entry of entries.slice(0, 200)) {
					// Limit entries per dir
					try {
						const fullPath = join(dir, entry);
						const stats = statSync(fullPath);
						if (stats.isFile() && (stats.mode & 0o111) !== 0) {
							executables.add(entry);
						}
					} catch {
						// Skip inaccessible files
					}
				}
			} catch {
				// Skip inaccessible directories
			}
		}

		const result = Array.from(executables).sort();
		this.executableCache.set(cacheKey, result);
		return result;
	}

	private getFuzzyHistoryMatches(prefix: string): string[] {
		if (!prefix) {
			return this.history.slice(-5).reverse();
		}
		const lowerPrefix = prefix.toLowerCase();
		return this.history
			.filter((cmd) => cmd.toLowerCase().includes(lowerPrefix))
			.slice(-10)
			.reverse();
	}

	private extractPathPrefix(text: string): string | null {
		// Find the last space-separated token
		const lastSpaceIdx = text.lastIndexOf(" ");
		if (lastSpaceIdx === -1) {
			return null; // First word = command completion, not path
		}
		const token = text.slice(lastSpaceIdx + 1);
		// Only complete if it looks like a path
		if (
			isAbsolute(token) ||
			token.startsWith("./") ||
			token.startsWith("../") ||
			token.startsWith("~/") ||
			token.includes("/") ||
			token.includes("\\")
		) {
			return token;
		}
		return null;
	}

	private getFileSuggestions(prefix: string): AutocompleteItem[] {
		try {
			let searchDir: string;
			let searchPrefix: string;

			const expandedPrefix = this.expandHomePath(prefix);

			if (expandedPrefix.endsWith("/")) {
				searchDir = expandedPrefix;
				searchPrefix = "";
			} else {
				searchDir = dirname(expandedPrefix);
				searchPrefix = basename(expandedPrefix);
			}

			if (!isAbsolute(searchDir)) {
				searchDir = join(this.basePath, searchDir);
			}

			if (!existsSync(searchDir)) {
				return [];
			}

			const entries = readdirSync(searchDir, { withFileTypes: true });
			const items: AutocompleteItem[] = [];

			for (const entry of entries) {
				if (
					searchPrefix &&
					!entry.name.toLowerCase().startsWith(searchPrefix.toLowerCase())
				) {
					continue;
				}

				const isDir = entry.isDirectory();
				const relativePath = this.buildRelativePath(prefix, entry.name);

				items.push({
					value: isDir ? `${relativePath}/` : relativePath,
					label: entry.name,
					description: isDir ? "directory" : "file",
				});
			}

			// Sort: directories first, then alphabetically
			items.sort((a, b) => {
				const aIsDir = a.description === "directory";
				const bIsDir = b.description === "directory";
				if (aIsDir && !bIsDir) return -1;
				if (!aIsDir && bIsDir) return 1;
				return a.label.localeCompare(b.label);
			});

			return items.slice(0, 15);
		} catch {
			return [];
		}
	}

	private expandHomePath(path: string): string {
		return expandTildePathWithHomeDir(path, getHomeDir());
	}

	private buildRelativePath(originalPrefix: string, entryName: string): string {
		if (originalPrefix.endsWith("/")) {
			return originalPrefix + entryName;
		}
		const dir = dirname(originalPrefix);
		if (dir === ".") {
			return entryName;
		}
		return join(dir, entryName);
	}
}
