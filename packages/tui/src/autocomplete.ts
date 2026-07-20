/**
 * @fileoverview Combined Autocomplete System for Slash Commands and File Paths
 *
 * This module provides a unified autocomplete provider that handles three distinct
 * completion scenarios in the TUI editor:
 *
 * 1. **Slash Commands**: `/command` autocompletion with argument support
 * 2. **File Paths**: Path completion for local file references
 * 3. **File Attachments**: `@path` syntax for attaching files to messages
 *
 * ## Architecture
 *
 * The autocomplete system uses a prefix-based triggering mechanism:
 * - `/` triggers slash command completion
 * - `@` triggers file attachment completion
 * - Path-like patterns (., ~/, /) trigger file path completion
 *
 * ## Caching Strategy
 *
 * Directory contents are cached with a 10-second TTL to balance responsiveness
 * with filesystem freshness. A prefetch mechanism loads common directories
 * on initialization to improve first-completion latency.
 *
 * ## Performance Considerations
 *
 * - Path extraction uses simple string operations to avoid regex backtracking
 * - Directory cache has a size limit (100 entries) to prevent memory bloat
 * - Prefetch is depth-limited and capped to prevent slow startup
 */
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import mimeTypes from "mime-types";

/**
 * Delimiters that separate path tokens in text.
 *
 * When extracting a path prefix from user input, we find the last occurrence
 * of any delimiter to isolate the current "word" being typed. This handles
 * scenarios like:
 * - `cd /foo/bar` → extracts `/foo/bar`
 * - `file="/path/to/file"` → extracts `/path/to/file`
 * - `@~/documents/file.txt` → extracts `@~/documents/file.txt`
 */
const PATH_DELIMITERS = [" ", "\t", '"', "'", "="] as const;

/**
 * Represents a single autocomplete suggestion.
 *
 * @property value - The text to insert when this item is selected
 * @property label - Display text shown in the autocomplete dropdown
 * @property description - Optional secondary text (e.g., "directory", "file")
 */
export interface AutocompleteItem {
	value: string;
	label: string;
	description?: string;
}

/**
 * Supported types for slash command arguments.
 * Used for validation and specialized completion behavior.
 */
export type CommandArgumentType = "string" | "number" | "boolean" | "enum";

/**
 * Definition of a single argument for a slash command.
 *
 * This enables rich argument completion where different commands can
 * define their expected arguments and provide custom completion logic.
 */
export interface CommandArgumentDefinition {
	/** Argument name (for help text and validation) */
	name: string;
	/** Data type for validation */
	type: CommandArgumentType;
	/** Whether this argument must be provided */
	required?: boolean;
	/** Help text for this argument */
	description?: string;
	/** Valid values for enum types */
	choices?: string[];
	/** Whether this argument can accept multiple values */
	variadic?: boolean;
	/** Default value if not specified */
	defaultValue?: string;
}

/**
 * Definition of a slash command for the autocomplete system.
 *
 * Commands can provide custom argument completion via the
 * `getArgumentCompletions` callback.
 */
export interface SlashCommand {
	/** Command name without the leading slash */
	name: string;
	/** Brief description shown in completion dropdown */
	description?: string;
	/** Usage string for help (e.g., "/cmd <arg1> [arg2]") */
	usage?: string;
	/** Example invocations */
	examples?: string[];
	/** Categorization tags */
	tags?: string[];
	/** Alternative names for this command */
	aliases?: string[];
	/** Formal argument definitions */
	arguments?: CommandArgumentDefinition[];
	/**
	 * Custom argument completion callback.
	 * Called when user is typing after the command name.
	 * @param argumentPrefix - Text typed after the command
	 * @returns Completion items or null to disable completion
	 */
	getArgumentCompletions?(argumentPrefix: string): AutocompleteItem[] | null;
}

/**
 * Interface for autocomplete providers.
 *
 * This abstraction allows different completion strategies to be plugged
 * into the editor component.
 */
export interface AutocompleteProvider {
	/**
	 * Gets completion suggestions for the current cursor position.
	 *
	 * @param lines - All lines in the editor buffer
	 * @param cursorLine - Current cursor line (0-indexed)
	 * @param cursorCol - Current cursor column (0-indexed)
	 * @returns Suggestions and the prefix to replace, or null if no completions
	 */
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): { items: AutocompleteItem[]; prefix: string } | null;

	/**
	 * Applies a selected completion to the editor buffer.
	 *
	 * @param lines - All lines in the editor buffer
	 * @param cursorLine - Current cursor line
	 * @param cursorCol - Current cursor column
	 * @param item - The selected completion item
	 * @param prefix - The prefix being replaced
	 * @returns Updated lines and new cursor position
	 */
	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number };
}

/**
 * Determines if a file can be attached to a message using the @ syntax.
 *
 * Attachable files include:
 * - Text files (source code, markdown, config files, etc.)
 * - Images (for multimodal context)
 *
 * This filter prevents users from accidentally attaching binary files
 * that would be meaningless or problematic in the conversation context.
 *
 * @param filePath - Path to the file to check
 * @returns true if the file can be attached
 */
function isAttachableFile(filePath: string): boolean {
	const mimeType = mimeTypes.lookup(filePath);

	// Comprehensive list of text file extensions
	// MIME type detection sometimes fails for source files
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
	// Fast path: check extension directly for known text types
	const ext = extname(filePath).toLowerCase();
	if (textExtensions.includes(ext)) return true;

	// Fall back to MIME type detection
	if (!mimeType) return false;
	if (mimeType.startsWith("image/")) return true;
	if (mimeType.startsWith("text/")) return true;

	// Some text formats have application/* MIME types
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

/**
 * Combined autocomplete provider for slash commands and file paths.
 *
 * This provider handles three completion modes:
 *
 * 1. **Slash Commands** (`/`): Completes command names and their arguments
 * 2. **File Attachments** (`@`): Completes paths for attachable files
 * 3. **File Paths**: Completes general filesystem paths
 *
 * ## State Management
 *
 * - `commands`: Registry of available slash commands
 * - `basePath`: Root directory for relative path resolution
 * - `dirCache`: LRU-ish cache of directory listings
 *
 * ## Threading Considerations
 *
 * Directory reads are synchronous (`readdirSync`) which is acceptable
 * for autocomplete since it runs on user input events. Caching mitigates
 * the performance impact of synchronous I/O.
 */
export class CombinedAutocompleteProvider implements AutocompleteProvider {
	/** Registered commands (may be full SlashCommand or simple AutocompleteItem) */
	private commands: (SlashCommand | AutocompleteItem)[];

	/** Base directory for resolving relative paths */
	private basePath: string;

	/**
	 * Directory content cache.
	 * Key: absolute directory path
	 * Value: { entries: directory contents, ts: cache timestamp }
	 */
	private dirCache = new Map<
		string,
		{ entries: Array<{ name: string; isDirectory: boolean }>; ts: number }
	>();

	/** Cache entry TTL in milliseconds (10 seconds) */
	private readonly dirCacheTtlMs = 10_000;

	/** Maximum number of cached directories (LRU eviction beyond this) */
	private readonly maxCachedDirs = 100;

	/** How deep to prefetch directories on initialization */
	private readonly prefetchDepth = 1;

	/** Maximum directories to prefetch (prevents slow startup) */
	private readonly maxPrefetchDirs = 20;

	/**
	 * Creates a new autocomplete provider.
	 *
	 * @param commands - Available slash commands
	 * @param basePath - Root directory for relative path completion
	 */
	constructor(
		commands: (SlashCommand | AutocompleteItem)[] = [],
		basePath: string = process.cwd(),
	) {
		this.commands = commands;
		this.basePath = basePath;

		// Warm the directory cache for faster first completions
		this.prefetchDirectories(this.basePath);
	}

	/**
	 * Updates the base path for relative path resolution.
	 * Called when the working directory changes.
	 */
	setBasePath(basePath: string): void {
		this.basePath = basePath;
		this.prefetchDirectories(basePath);
	}
	/**
	 * Gets completion suggestions based on current input context.
	 *
	 * This method implements a priority-based completion strategy:
	 * 1. Slash commands take precedence (if line starts with /)
	 * 2. File paths are completed otherwise
	 *
	 * @param lines - Editor buffer content
	 * @param cursorLine - Current line number
	 * @param cursorCol - Current column number
	 * @returns Suggestions with prefix, or null if no completions available
	 */
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): { items: AutocompleteItem[]; prefix: string } | null {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		// ────────────────────────────────────────────────────────
		// SLASH COMMAND COMPLETION
		// ────────────────────────────────────────────────────────
		if (textBeforeCursor.startsWith("/")) {
			const spaceIndex = textBeforeCursor.indexOf(" ");

			if (spaceIndex === -1) {
				// No space yet - user is typing the command name
				// Extract prefix without the leading "/"
				const prefix = textBeforeCursor.slice(1).toLowerCase();

				// Filter commands that match the prefix (name or aliases)
				const filtered = this.commands
					.filter((cmd) => {
						const name = "name" in cmd ? cmd.name : cmd.value;
						const aliases = "aliases" in cmd && cmd.aliases ? cmd.aliases : [];
						// Match command name or any alias
						return (
							name?.toLowerCase().startsWith(prefix) ||
							aliases.some((a) => a.toLowerCase().startsWith(prefix))
						);
					})
					.map((cmd) => {
						const name = "name" in cmd ? cmd.name : cmd.value;
						const aliases = "aliases" in cmd && cmd.aliases ? cmd.aliases : [];
						// Show short aliases in label for discoverability (e.g., "help (h)")
						const shortAliases = aliases.filter((a) => a.length <= 2);
						const label =
							shortAliases.length > 0
								? `${name} (${shortAliases.join(", ")})`
								: name;
						return {
							value: name,
							label,
							...(cmd.description && { description: cmd.description }),
						};
					});

				if (filtered.length === 0) return null;
				return {
					items: filtered,
					prefix: textBeforeCursor, // Include "/" in prefix for correct replacement
				};
			}

			// Space found - user is now typing command arguments
			const commandName = textBeforeCursor.slice(1, spaceIndex).toLowerCase();
			const argumentText = textBeforeCursor.slice(spaceIndex + 1);

			// Find the command (by name or alias) to get its argument completer
			const command = this.commands.find((cmd) => {
				const name = "name" in cmd ? cmd.name : cmd.value;
				const aliases = "aliases" in cmd && cmd.aliases ? cmd.aliases : [];
				return (
					name?.toLowerCase() === commandName ||
					aliases.some((a) => a.toLowerCase() === commandName)
				);
			});

			// Delegate to command's custom argument completion
			if (
				!command ||
				!("getArgumentCompletions" in command) ||
				!command.getArgumentCompletions
			) {
				return null; // Command doesn't support argument completion
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

		// ────────────────────────────────────────────────────────
		// FILE PATH COMPLETION
		// ────────────────────────────────────────────────────────
		// Check for file paths - triggered if we detect a path pattern
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
	/**
	 * Applies a selected completion to the editor buffer.
	 *
	 * This method handles different completion contexts:
	 * 1. Slash commands: Replaces "/prefix" with "/command " (adds space)
	 * 2. File attachments: Replaces "@prefix" with "@path " (adds space if needed)
	 * 3. Command arguments: Replaces argument prefix with selected value
	 * 4. File paths: Replaces path prefix with selected path
	 *
	 * @param lines - Current editor buffer
	 * @param cursorLine - Line containing the cursor
	 * @param cursorCol - Column position of cursor
	 * @param item - Selected completion item
	 * @param prefix - The text being replaced
	 * @returns Updated buffer and new cursor position
	 */
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

		// ────────────────────────────────────────────────────────
		// SLASH COMMAND NAME COMPLETION
		// ────────────────────────────────────────────────────────
		if (prefix.startsWith("/")) {
			// Replace "/prefix" with "/command " - add trailing space for convenience
			const newLine = `${beforePrefix}/${item.value} ${afterCursor}`;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;
			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length + 2, // +2 for "/" and space
			};
		}

		// ────────────────────────────────────────────────────────
		// FILE ATTACHMENT COMPLETION
		// ────────────────────────────────────────────────────────
		if (prefix.startsWith("@")) {
			// Avoid inserting double spaces if there's already one after cursor
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

		// ────────────────────────────────────────────────────────
		// COMMAND ARGUMENT COMPLETION
		// ────────────────────────────────────────────────────────
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		if (textBeforeCursor.includes("/") && textBeforeCursor.includes(" ")) {
			// We're in a "/command arg" context - replace just the argument
			const newLine = beforePrefix + item.value + afterCursor;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;
			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length,
			};
		}

		// ────────────────────────────────────────────────────────
		// GENERAL FILE PATH COMPLETION
		// ────────────────────────────────────────────────────────
		const newLine = beforePrefix + item.value + afterCursor;
		const newLines = [...lines];
		newLines[cursorLine] = newLine;
		return {
			lines: newLines,
			cursorLine,
			cursorCol: beforePrefix.length + item.value.length,
		};
	}
	/**
	 * Extracts a path-like prefix from text for completion.
	 *
	 * This method identifies the "current word" being typed by finding the
	 * last delimiter and extracting everything after it. It handles:
	 *
	 * - `@` file attachment syntax
	 * - Absolute paths (`/foo/bar`)
	 * - Home-relative paths (`~/foo`)
	 * - Relative paths (`./foo`, `../bar`)
	 *
	 * ## Performance Note
	 *
	 * Uses simple string operations instead of regex to avoid catastrophic
	 * backtracking that could freeze the UI on pathological inputs.
	 *
	 * @param text - Text before cursor
	 * @param forceExtract - If true, always return something (used for Tab key)
	 * @returns Path prefix to complete, or null if no path context detected
	 */
	protected extractPathPrefix(
		text: string,
		forceExtract = false,
	): string | null {
		// Priority 1: Check for @ file attachment syntax
		const atMatch = text.match(/@([^\s]*)$/);
		if (atMatch) {
			return atMatch[0]; // Return the full @path pattern including @
		}

		// Find the last delimiter to isolate the current "word"
		// Use simple indexOf instead of regex for performance
		const lastDelimiterIndex = Math.max(
			...PATH_DELIMITERS.map((delim) => text.lastIndexOf(delim)),
		);

		const pathPrefix =
			lastDelimiterIndex === -1 ? text : text.slice(lastDelimiterIndex + 1);

		// For Tab key, always return whatever we have
		if (forceExtract) {
			return pathPrefix;
		}

		// For natural triggers (typing), only complete if it looks like a path
		// This prevents unwanted completions when typing normal text
		if (
			pathPrefix.includes("/") ||
			pathPrefix.startsWith(".") ||
			pathPrefix.startsWith("~/")
		) {
			return pathPrefix;
		}

		// Allow completion at line start or after whitespace
		// But not after quotes or equals (those need explicit Tab)
		if (
			pathPrefix === "" &&
			(text === "" || text.endsWith(" ") || text.endsWith("\t"))
		) {
			return pathPrefix;
		}

		return null;
	}
	/**
	 * Expands home directory shorthand to absolute path.
	 *
	 * Handles:
	 * - `~` → `/home/user` (or equivalent on other platforms)
	 * - `~/foo` → `/home/user/foo`
	 *
	 * Trailing slashes are preserved to maintain user intent.
	 *
	 * @param path - Path that may start with ~
	 * @returns Expanded absolute path
	 */
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

	/**
	 * Generates file/directory suggestions for a path prefix.
	 *
	 * This method:
	 * 1. Determines the search directory and filename prefix
	 * 2. Reads directory contents (from cache or filesystem)
	 * 3. Filters entries by prefix and type (for @ syntax, only attachable files)
	 * 4. Builds relative paths for display
	 * 5. Sorts (directories first, then alphabetical)
	 * 6. Limits results to 10 items
	 *
	 * @param prefix - The partial path to complete
	 * @returns Array of completion items
	 */
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
	/**
	 * Forces file completion triggered by Tab key.
	 *
	 * Unlike natural triggers in getSuggestions, this always attempts
	 * file completion regardless of whether the input looks like a path.
	 * This allows users to Tab-complete from any position.
	 *
	 * @param lines - Editor buffer
	 * @param cursorLine - Current line
	 * @param cursorCol - Current column
	 * @returns Suggestions and prefix, or null if in slash command context
	 */
	getForceFileSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): { items: AutocompleteItem[]; prefix: string } | null {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		// Don't hijack Tab in slash command context
		if (textBeforeCursor.startsWith("/") && !textBeforeCursor.includes(" ")) {
			return null;
		}

		// Force extract path prefix - always returns something
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

	/**
	 * Checks if Tab-triggered file completion should activate.
	 *
	 * Returns false if we're in a slash command context (without arguments),
	 * as Tab should cycle through command completions instead.
	 */
	shouldTriggerFileCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): boolean {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		// Slash command mode - Tab should cycle commands, not files
		if (textBeforeCursor.startsWith("/") && !textBeforeCursor.includes(" ")) {
			return false;
		}
		return true;
	}

	/**
	 * Reads directory entries with caching.
	 *
	 * Cache entries are invalidated after dirCacheTtlMs (10 seconds).
	 * When cache exceeds maxCachedDirs, oldest entries are evicted.
	 *
	 * @param dir - Directory path to read
	 * @returns Array of entry names and types
	 */
	private readDirEntries(
		dir: string,
	): Array<{ name: string; isDirectory: boolean }> {
		const cached = this.dirCache.get(dir);
		const now = Date.now();

		// Return cached entries if still valid
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

			// Update cache
			this.dirCache.set(dir, { entries, ts: now });

			// Evict oldest entries if cache is full (simple FIFO eviction)
			while (this.dirCache.size > this.maxCachedDirs) {
				const iterator = this.dirCache.keys().next();
				if (iterator.done || !iterator.value) {
					break;
				}
				this.dirCache.delete(iterator.value);
			}

			return entries;
		} catch {
			// Return empty on permission errors, non-existent dirs, etc.
			return [];
		}
	}

	/**
	 * Builds the completion value (path) for a directory entry.
	 *
	 * This reconstructs the path in the same format the user was typing:
	 * - Preserves ~ notation for home-relative paths
	 * - Preserves @ prefix for file attachments
	 * - Uses relative paths when appropriate
	 *
	 * @param originalPrefix - What the user typed
	 * @param expandedPrefix - Prefix with ~ expanded
	 * @param entryName - Filename to append
	 * @param isAtPrefix - Whether this is a file attachment (@)
	 * @returns Complete path for the completion item
	 */
	protected buildRelativePath(
		originalPrefix: string,
		expandedPrefix: string,
		entryName: string,
		isAtPrefix: boolean,
	): string {
		// Handle @ file attachment paths
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

		// Handle regular paths
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

	/**
	 * Pre-populates the directory cache for faster first completions.
	 *
	 * Uses BFS traversal with depth and count limits to prevent:
	 * - Deep recursion into large directory trees
	 * - Slow startup times
	 * - Excessive memory usage
	 *
	 * Only the first 5 subdirectories at each level are prefetched.
	 *
	 * @param root - Starting directory for prefetch
	 */
	private prefetchDirectories(root: string): void {
		const queue: Array<{ dir: string; depth: number }> = [
			{ dir: root, depth: this.prefetchDepth },
		];
		const visited = new Set<string>();
		let processed = 0;

		while (queue.length && processed < this.maxPrefetchDirs) {
			const next = queue.shift();
			if (!next) break;

			// Skip already-visited directories (handles symlink loops)
			if (visited.has(next.dir)) {
				continue;
			}
			visited.add(next.dir);

			// Read and cache this directory
			const entries = this.readDirEntries(next.dir);
			processed++;

			// Stop descending if we've reached max depth
			if (next.depth <= 0) {
				continue;
			}

			// Queue child directories (limit to first 5 to prevent explosion)
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
