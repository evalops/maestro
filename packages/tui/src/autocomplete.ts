import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import mimeTypes from "mime-types";

/**
 * Delimiters used for extracting paths from text
 */
const PATH_DELIMITERS = [" ", "\t", '"', "'", "="] as const;

export interface AutocompleteItem {
	value: string;
	label: string;
	description?: string;
}

export type CommandArgumentType = "string" | "number" | "boolean" | "enum";

export interface CommandArgumentDefinition {
	name: string;
	type: CommandArgumentType;
	required?: boolean;
	description?: string;
	choices?: string[];
	variadic?: boolean;
	defaultValue?: string;
}

export interface SlashCommand {
	name: string;
	description?: string;
	usage?: string;
	examples?: string[];
	tags?: string[];
	aliases?: string[];
	arguments?: CommandArgumentDefinition[];
	getArgumentCompletions?(argumentPrefix: string): AutocompleteItem[] | null;
}

export interface AutocompleteProvider {
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): { items: AutocompleteItem[]; prefix: string } | null;
	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number };
}

function isAttachableFile(filePath: string): boolean {
	const mimeType = mimeTypes.lookup(filePath);
	// Check file extension for common text files that might be misidentified
	const textExtensions = [
		".txt",
		".md",
		".markdown",
		".js",
		".ts",
		".tsx",
		".jsx",
		".py",
		".java",
		".c",
		".cpp",
		".h",
		".hpp",
		".cs",
		".php",
		".rb",
		".go",
		".rs",
		".swift",
		".kt",
		".scala",
		".sh",
		".bash",
		".zsh",
		".fish",
		".html",
		".htm",
		".css",
		".scss",
		".sass",
		".less",
		".xml",
		".json",
		".yaml",
		".yml",
		".toml",
		".ini",
		".cfg",
		".conf",
		".log",
		".sql",
		".r",
		".R",
		".m",
		".pl",
		".lua",
		".vim",
		".dockerfile",
		".makefile",
		".cmake",
		".gradle",
		".maven",
		".properties",
		".env",
	];
	const ext = extname(filePath).toLowerCase();
	if (textExtensions.includes(ext)) return true;
	if (!mimeType) return false;
	if (mimeType.startsWith("image/")) return true;
	if (mimeType.startsWith("text/")) return true;
	// Special cases for common text files that might not be detected as text/
	const commonTextTypes = [
		"application/json",
		"application/javascript",
		"application/typescript",
		"application/xml",
		"application/yaml",
		"application/x-yaml",
	];
	return commonTextTypes.includes(mimeType);
}
// Combined provider that handles both slash commands and file paths
export class CombinedAutocompleteProvider implements AutocompleteProvider {
	private commands: (SlashCommand | AutocompleteItem)[];
	private basePath: string;
	private dirCache = new Map<
		string,
		{ entries: Array<{ name: string; isDirectory: boolean }>; ts: number }
	>();
	private readonly dirCacheTtlMs = 10_000;
	private readonly maxCachedDirs = 100;
	private readonly prefetchDepth = 1;
	private readonly maxPrefetchDirs = 20;

	constructor(
		commands: (SlashCommand | AutocompleteItem)[] = [],
		basePath: string = process.cwd(),
	) {
		this.commands = commands;
		this.basePath = basePath;
		this.prefetchDirectories(this.basePath);
	}
	setBasePath(basePath: string): void {
		this.basePath = basePath;
		this.prefetchDirectories(basePath);
	}
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): { items: AutocompleteItem[]; prefix: string } | null {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		// Check for slash commands
		if (textBeforeCursor.startsWith("/")) {
			const spaceIndex = textBeforeCursor.indexOf(" ");
			if (spaceIndex === -1) {
				// No space yet - complete command names
				const prefix = textBeforeCursor.slice(1); // Remove the "/"
				const filtered = this.commands
					.filter((cmd) => {
						const name = "name" in cmd ? cmd.name : cmd.value; // Check if SlashCommand or AutocompleteItem
						return name?.toLowerCase().startsWith(prefix.toLowerCase());
					})
					.map((cmd) => ({
						value: "name" in cmd ? cmd.name : cmd.value,
						label: "name" in cmd ? cmd.name : cmd.label,
						...(cmd.description && { description: cmd.description }),
					}));
				if (filtered.length === 0) return null;
				return {
					items: filtered,
					prefix: textBeforeCursor,
				};
			}
			// Space found - complete command arguments
			const commandName = textBeforeCursor.slice(1, spaceIndex); // Command without "/"
			const argumentText = textBeforeCursor.slice(spaceIndex + 1); // Text after space
			const command = this.commands.find((cmd) => {
				const name = "name" in cmd ? cmd.name : cmd.value;
				return name === commandName;
			});
			if (
				!command ||
				!("getArgumentCompletions" in command) ||
				!command.getArgumentCompletions
			) {
				return null; // No argument completion for this command
			}
			const argumentSuggestions = command.getArgumentCompletions(argumentText);
			if (!argumentSuggestions || argumentSuggestions.length === 0) {
				return null;
			}
			return {
				items: argumentSuggestions,
				prefix: argumentText,
			};
		}
		// Check for file paths - triggered by Tab or if we detect a path pattern
		const pathMatch = this.extractPathPrefix(textBeforeCursor, false);
		if (pathMatch !== null) {
			const suggestions = this.getFileSuggestions(pathMatch);
			if (suggestions.length === 0) return null;
			return {
				items: suggestions,
				prefix: pathMatch,
			};
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
		// Check if we're completing a slash command (prefix starts with "/")
		if (prefix.startsWith("/")) {
			// This is a command name completion
			const newLine = `${beforePrefix}/${item.value} ${afterCursor}`;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;
			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length + 2, // +2 for "/" and space
			};
		}
		// Check if we're completing a file attachment (prefix starts with "@")
		if (prefix.startsWith("@")) {
			// This is a file attachment completion, avoid double space
			const spacer = afterCursor.startsWith(" ") ? "" : " ";
			const newLine = `${beforePrefix}${item.value}${spacer}${afterCursor}`;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;
			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length + spacer.length,
			};
		}
		// Check if we're in a slash command context (beforePrefix contains "/command ")
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		if (textBeforeCursor.includes("/") && textBeforeCursor.includes(" ")) {
			// This is likely a command argument completion
			const newLine = beforePrefix + item.value + afterCursor;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;
			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length,
			};
		}
		// For file paths, complete the path
		const newLine = beforePrefix + item.value + afterCursor;
		const newLines = [...lines];
		newLines[cursorLine] = newLine;
		return {
			lines: newLines,
			cursorLine,
			cursorCol: beforePrefix.length + item.value.length,
		};
	}
	// Extract a path-like prefix from the text before cursor
	protected extractPathPrefix(
		text: string,
		forceExtract = false,
	): string | null {
		// Check for @ file attachment syntax first
		const atMatch = text.match(/@([^\s]*)$/);
		if (atMatch) {
			return atMatch[0]; // Return the full @path pattern
		}
		// Simple approach: find the last whitespace/delimiter and extract the word after it
		// This avoids catastrophic backtracking from nested quantifiers
		const lastDelimiterIndex = Math.max(
			...PATH_DELIMITERS.map((delim) => text.lastIndexOf(delim)),
		);

		const pathPrefix =
			lastDelimiterIndex === -1 ? text : text.slice(lastDelimiterIndex + 1);
		// For forced extraction (Tab key), always return something
		if (forceExtract) {
			return pathPrefix;
		}
		// For natural triggers, return if it looks like a path, ends with /, starts with ~/, .
		// Only return empty string if the text looks like it's starting a path context
		if (
			pathPrefix.includes("/") ||
			pathPrefix.startsWith(".") ||
			pathPrefix.startsWith("~/")
		) {
			return pathPrefix;
		}
		// Return empty string only if we're at the beginning of the line or after a space/tab
		// (not after quotes or other delimiters that don't suggest file paths)
		if (
			pathPrefix === "" &&
			(text === "" || text.endsWith(" ") || text.endsWith("\t"))
		) {
			return pathPrefix;
		}
		return null;
	}
	// Expand home directory (~/) to actual home path
	private expandHomePath(path: string): string {
		if (path.startsWith("~/")) {
			const expandedPath = join(homedir(), path.slice(2));
			// Preserve trailing slash if original path had one
			return path.endsWith("/") && !expandedPath.endsWith("/")
				? `${expandedPath}/`
				: expandedPath;
		}
		if (path === "~") {
			return homedir();
		}
		return path;
	}
	// Get file/directory suggestions for a given path prefix
	protected getFileSuggestions(prefix: string): AutocompleteItem[] {
		try {
			let searchDir = "";
			let searchPrefix = "";
			let expandedPrefix = prefix;
			let isAtPrefix = false;
			if (prefix.startsWith("@")) {
				isAtPrefix = true;
				expandedPrefix = prefix.slice(1);
			}
			if (expandedPrefix.startsWith("~")) {
				expandedPrefix = this.expandHomePath(expandedPrefix);
			}
			if (expandedPrefix.startsWith("/")) {
				if (expandedPrefix.endsWith("/")) {
					searchDir = expandedPrefix;
				} else {
					searchDir = dirname(expandedPrefix);
					searchPrefix = basename(expandedPrefix);
				}
			} else if (
				!expandedPrefix ||
				expandedPrefix === "." ||
				expandedPrefix === "./"
			) {
				searchDir = this.basePath;
			} else if (expandedPrefix.endsWith("/")) {
				searchDir = join(this.basePath, expandedPrefix);
			} else {
				const dir = dirname(expandedPrefix);
				searchDir = join(this.basePath, dir === "." ? "" : dir);
				searchPrefix = basename(expandedPrefix);
			}
			const entries = this.readDirEntries(searchDir);
			const suggestions: AutocompleteItem[] = [];
			for (const entry of entries) {
				if (
					searchPrefix &&
					!entry.name.toLowerCase().startsWith(searchPrefix.toLowerCase())
				) {
					continue;
				}
				if (isAtPrefix && !entry.isDirectory) {
					const fullPath = join(searchDir, entry.name);
					if (!isAttachableFile(fullPath)) {
						continue;
					}
				}
				const relativePath = this.buildRelativePath(
					prefix,
					expandedPrefix,
					entry.name,
					isAtPrefix,
				);
				suggestions.push({
					value: entry.isDirectory ? `${relativePath}/` : relativePath,
					label: entry.name,
					description: entry.isDirectory ? "directory" : "file",
				});
			}
			suggestions.sort((a, b) => {
				const aIsDir = a.description === "directory";
				const bIsDir = b.description === "directory";
				if (aIsDir && !bIsDir) return -1;
				if (!aIsDir && bIsDir) return 1;
				return a.label.localeCompare(b.label);
			});
			return suggestions.slice(0, 10);
		} catch {
			return [];
		}
	}
	// Force file completion (called on Tab key) - always returns suggestions
	getForceFileSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): { items: AutocompleteItem[]; prefix: string } | null {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		// Don't trigger if we're in a slash command
		if (textBeforeCursor.startsWith("/") && !textBeforeCursor.includes(" ")) {
			return null;
		}
		// Force extract path prefix - this will always return something
		const pathMatch = this.extractPathPrefix(textBeforeCursor, true);
		if (pathMatch !== null) {
			const suggestions = this.getFileSuggestions(pathMatch);
			if (suggestions.length === 0) return null;
			return {
				items: suggestions,
				prefix: pathMatch,
			};
		}
		return null;
	}
	// Check if we should trigger file completion (called on Tab key)
	shouldTriggerFileCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): boolean {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		// Don't trigger if we're in a slash command
		if (textBeforeCursor.startsWith("/") && !textBeforeCursor.includes(" ")) {
			return false;
		}
		return true;
	}

	private readDirEntries(
		dir: string,
	): Array<{ name: string; isDirectory: boolean }> {
		const cached = this.dirCache.get(dir);
		const now = Date.now();
		if (cached && now - cached.ts < this.dirCacheTtlMs) {
			return cached.entries;
		}
		try {
			const entries = readdirSync(dir, { withFileTypes: true }).map(
				(entry) => ({
					name: entry.name,
					isDirectory: entry.isDirectory(),
				}),
			);
			this.dirCache.set(dir, { entries, ts: now });
			while (this.dirCache.size > this.maxCachedDirs) {
				const iterator = this.dirCache.keys().next();
				if (iterator.done || !iterator.value) {
					break;
				}
				this.dirCache.delete(iterator.value);
			}
			return entries;
		} catch {
			return [];
		}
	}

	protected buildRelativePath(
		originalPrefix: string,
		expandedPrefix: string,
		entryName: string,
		isAtPrefix: boolean,
	): string {
		if (isAtPrefix) {
			if (expandedPrefix.endsWith("/")) {
				return `@${expandedPrefix}${entryName}`;
			}
			if (expandedPrefix.includes("/")) {
				if (expandedPrefix.startsWith("~/")) {
					const slice = expandedPrefix.slice(2);
					const dir = dirname(slice);
					return `@~/${dir === "." ? entryName : join(dir, entryName)}`;
				}
				return `@${join(dirname(expandedPrefix), entryName)}`;
			}
			if (expandedPrefix.startsWith("~")) {
				return `@~/${entryName}`;
			}
			return `@${entryName}`;
		}
		if (originalPrefix.endsWith("/")) {
			return originalPrefix + entryName;
		}
		if (originalPrefix.includes("/")) {
			if (originalPrefix.startsWith("~/")) {
				const rel = originalPrefix.slice(2);
				const dir = dirname(rel);
				return `~/${dir === "." ? entryName : join(dir, entryName)}`;
			}
			return join(dirname(originalPrefix), entryName);
		}
		if (originalPrefix.startsWith("~")) {
			return `~/${entryName}`;
		}
		return entryName;
	}

	private prefetchDirectories(root: string): void {
		const queue: Array<{ dir: string; depth: number }> = [
			{ dir: root, depth: this.prefetchDepth },
		];
		const visited = new Set<string>();
		let processed = 0;
		while (queue.length && processed < this.maxPrefetchDirs) {
			const next = queue.shift();
			if (!next) break;
			if (visited.has(next.dir)) {
				continue;
			}
			visited.add(next.dir);
			const entries = this.readDirEntries(next.dir);
			processed++;
			if (next.depth <= 0) {
				continue;
			}
			let childCount = 0;
			for (const entry of entries) {
				if (!entry.isDirectory) {
					continue;
				}
				queue.push({
					dir: join(next.dir, entry.name),
					depth: next.depth - 1,
				});
				childCount++;
				if (childCount >= 5) {
					break;
				}
			}
		}
	}
}
