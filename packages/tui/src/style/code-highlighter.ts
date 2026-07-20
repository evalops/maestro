/**
 * @fileoverview Lightweight Syntax Highlighting for Terminal Display
 *
 * This module provides fast, regex-based syntax highlighting for code blocks
 * in terminal output. Unlike full parsers (tree-sitter, etc.), this uses
 * simple pattern matching that's fast enough for real-time rendering.
 *
 * ## Supported Languages
 *
 * - **JSON/JSONC**: Keys, values, strings, numbers, booleans
 * - **Shell**: Commands, flags, comments
 * - **Diff**: Added (+), removed (-), and meta (@@) lines
 * - **JavaScript/TypeScript**: Keywords, strings, numbers, comments
 * - **Python**: Keywords, strings (including triple-quoted), comments
 * - **SQL**: Keywords (uppercase), strings, numbers
 * - **YAML**: Keys, values, strings, booleans
 *
 * ## Design Philosophy
 *
 * 1. **Speed over Accuracy**: Good-enough highlighting that's fast
 * 2. **No Dependencies**: Uses only chalk for ANSI colors
 * 3. **Line-at-a-time**: Each line is processed independently
 * 4. **Graceful Degradation**: Unknown languages get default styling
 *
 * ## Color Palette
 *
 * The colors are chosen for readability on dark terminal backgrounds:
 * - Keywords: Pink (#f472b6)
 * - Strings: Light pink (#f9a8d4)
 * - Numbers: Yellow (#fcd34d)
 * - Comments: Slate (#94a3b8)
 * - Default: Light gray (#e2e8f0)
 */
import chalk from "chalk";

/**
 * A painter function takes a line of code and returns it with ANSI styling.
 */
type Painter = (line: string) => string;

/**
 * JavaScript/TypeScript reserved keywords.
 * These are highlighted in pink when encountered as whole words.
 */
const JS_KEYWORDS = new Set([
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"debugger",
	"default",
	"delete",
	"do",
	"else",
	"enum",
	"export",
	"extends",
	"finally",
	"for",
	"from",
	"function",
	"if",
	"import",
	"in",
	"instanceof",
	"let",
	"new",
	"return",
	"switch",
	"this",
	"throw",
	"try",
	"typeof",
	"var",
	"void",
	"while",
	"with",
	"yield",
	"async",
	"await",
]);

/**
 * Python reserved keywords.
 */
const PY_KEYWORDS = new Set([
	"def",
	"class",
	"import",
	"from",
	"return",
	"if",
	"elif",
	"else",
	"for",
	"while",
	"try",
	"except",
	"finally",
	"with",
	"as",
	"pass",
	"continue",
	"break",
	"yield",
	"lambda",
	"async",
	"await",
]);

/**
 * SQL reserved keywords (matched case-insensitively).
 * These are uppercased when displayed for conventional SQL formatting.
 */
const SQL_KEYWORDS = new Set([
	"select",
	"from",
	"where",
	"group",
	"by",
	"order",
	"insert",
	"into",
	"values",
	"update",
	"set",
	"delete",
	"join",
	"left",
	"right",
	"inner",
	"outer",
	"on",
	"limit",
	"offset",
	"create",
	"table",
	"primary",
	"key",
	"unique",
]);

// ────────────────────────────────────────────────────────────────────────────
// COLOR PALETTE
// These colors are optimized for dark terminal backgrounds
// ────────────────────────────────────────────────────────────────────────────

/** Default code color (light gray) */
const DEFAULT_CODE_COLOR = chalk.hex("#e2e8f0");

/** Comment color (muted slate) */
const COMMENT_COLOR = chalk.hex("#94a3b8");

/** Keyword color (pink) */
const KEYWORD_COLOR = chalk.hex("#f472b6");

/** Number literal color (yellow) */
const NUMBER_COLOR = chalk.hex("#fcd34d");

/** String literal color (light pink) */
const STRING_COLOR = chalk.hex("#f9a8d4");

/** Diff: added lines (green) */
const DIFF_ADD = chalk.hex("#4ade80");

/** Diff: removed lines (red) */
const DIFF_REMOVE = chalk.hex("#f87171");

/** Diff: meta lines like @@ (blue) */
const DIFF_META = chalk.hex("#38bdf8");

/** Shell: command name (bold blue) */
const SHELL_CMD = chalk.hex("#93c5fd").bold;

/** Shell: flags and options (yellow) */
const SHELL_FLAG = chalk.hex("#fcd34d");

// ────────────────────────────────────────────────────────────────────────────
// LANGUAGE DETECTION
// Maps language identifiers to painter groups
// ────────────────────────────────────────────────────────────────────────────

const JSON_LANGS = new Set(["json", "jsonc"]);
const SHELL_LANGS = new Set([
	"bash",
	"sh",
	"shell",
	"zsh",
	"powershell",
	"pwsh",
]);
const DIFF_LANGS = new Set(["diff", "patch"]);
const JS_LANGS = new Set([
	"js",
	"jsx",
	"ts",
	"tsx",
	"javascript",
	"typescript",
]);
const PY_LANGS = new Set(["py", "python"]);
const SQL_LANGS = new Set(["sql"]);
const YAML_LANGS = new Set(["yaml", "yml"]);

// ────────────────────────────────────────────────────────────────────────────
// UTILITY FUNCTIONS
// ────────────────────────────────────────────────────────────────────────────

/**
 * Separates leading whitespace from the rest of the line.
 * This allows us to preserve indentation while styling the code.
 *
 * @param line - Input line
 * @returns Object with indent (whitespace) and body (rest of line)
 */
function stripIndent(line: string): { indent: string; body: string } {
	const match = line.match(/^\s*/);
	const indent = match ? match[0] : "";
	return { indent, body: line.slice(indent.length) };
}

// ────────────────────────────────────────────────────────────────────────────
// LANGUAGE-SPECIFIC PAINTERS
// Each painter handles one language or family of languages
// ────────────────────────────────────────────────────────────────────────────

/**
 * Default painter: applies base code color to the entire line.
 */
function paintDefault(line: string): string {
	if (!line) return "";
	return DEFAULT_CODE_COLOR(line);
}

/**
 * JSON painter: highlights keys, string values, numbers, and booleans.
 *
 * Pattern matching:
 * - Keys: `"key":` → cyan key
 * - String values: `: "value"` → pink value
 * - Number values: `: 123` → yellow number
 * - Booleans/null: `true`, `false`, `null` → green
 */
function paintJson(line: string): string {
	const { indent, body } = stripIndent(line);
	let result = body;

	// Match JSON keys (strings followed by colon)
	result = result.replace(/"([^"]*)"(?=\s*:)/g, (_match, key) =>
		chalk.hex("#7dd3fc")(`"${key}"`),
	);

	// Match string values after colon
	result = result.replace(
		/:\s*("[^"]*")/g,
		(_m, value) => `: ${STRING_COLOR(value)}`,
	);

	// Match numeric values after colon
	result = result.replace(
		/:\s*(-?\d+(?:\.\d+)?)/g,
		(_m, value) => `: ${NUMBER_COLOR(value)}`,
	);

	// Match boolean and null literals
	result = result.replace(/\b(true|false|null)\b/g, (_m, val) =>
		chalk.hex("#34d399")(val),
	);

	return indent + result;
}

/**
 * Shell painter: highlights commands, flags, and comments.
 *
 * Recognizes:
 * - Comments: lines starting with #
 * - Commands: first word (bold blue)
 * - Long flags: --flag-name (yellow)
 * - Short flags: -f (yellow)
 */
function paintShell(line: string): string {
	const { indent, body } = stripIndent(line);
	const trimmed = body.trim();

	if (!trimmed) return indent;

	// Shell comments
	if (trimmed.startsWith("#")) {
		return indent + COMMENT_COLOR(trimmed);
	}

	// Split into command and arguments
	const parts = trimmed.split(/\s+/);
	const [command, ...rest] = parts;

	// Highlight flags in the arguments
	let restJoined = rest.join(" ");
	restJoined = restJoined.replace(/(--[\w-]+)/g, (_m, flag) =>
		SHELL_FLAG(flag),
	);
	restJoined = restJoined.replace(/\b(-[\w])\b/g, (_m, flag) =>
		SHELL_FLAG(flag),
	);

	return indent + SHELL_CMD(command) + (restJoined ? ` ${restJoined}` : "");
}

/**
 * Diff painter: colors based on line prefix.
 *
 * Conventions:
 * - `+++`/`---`: File headers (blue)
 * - `@@`: Hunk headers (blue)
 * - `+`: Added lines (green)
 * - `-`: Removed lines (red)
 * - Everything else: default color
 */
function paintDiff(line: string): string {
	if (line.startsWith("+++") || line.startsWith("---")) {
		return DIFF_META(line);
	}
	if (line.startsWith("@@")) {
		return DIFF_META(line);
	}
	if (line.startsWith("+")) {
		return DIFF_ADD(line);
	}
	if (line.startsWith("-")) {
		return DIFF_REMOVE(line);
	}
	return DEFAULT_CODE_COLOR(line);
}

/**
 * Generic keyword-based painter for C-like languages.
 *
 * Handles:
 * - // style comments
 * - String literals (", ', `)
 * - Number literals
 * - Keywords from the provided set
 *
 * @param line - Input line
 * @param keywords - Set of language keywords to highlight
 */
function paintKeywordLine(line: string, keywords: Set<string>): string {
	const { indent, body } = stripIndent(line);
	if (!body) return indent;

	// Split code from trailing comment
	const commentIndex = body.indexOf("//");
	let code = commentIndex >= 0 ? body.slice(0, commentIndex) : body;
	const comment = commentIndex >= 0 ? body.slice(commentIndex) : "";

	// Highlight numbers
	code = code.replace(/\b(\d+(?:\.\d+)?)\b/g, (_m, value) =>
		NUMBER_COLOR(value),
	);

	// Highlight keywords
	code = code.replace(/\b([A-Za-z_][\w]*)\b/g, (_m, word) =>
		keywords.has(word) ? KEYWORD_COLOR(word) : word,
	);

	// Highlight strings (double, single, and template literals)
	const stringRegex = /("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`)/g;
	code = code.replace(stringRegex, (match) => STRING_COLOR(match));

	return indent + code + (comment ? COMMENT_COLOR(comment) : "");
}

/**
 * Python painter: handles Python-specific syntax.
 *
 * Differences from C-like languages:
 * - Comments start with # instead of //
 * - Triple-quoted strings (""" and ''')
 * - Python-specific keywords
 */
function paintPython(line: string): string {
	const { indent, body } = stripIndent(line);
	if (!body) return indent;

	// Python comments use #
	const commentIndex = body.indexOf("#");
	let code = commentIndex >= 0 ? body.slice(0, commentIndex) : body;
	const comment = commentIndex >= 0 ? body.slice(commentIndex) : "";

	// Highlight numbers
	code = code.replace(/\b(\d+(?:\.\d+)?)\b/g, (_m, value) =>
		NUMBER_COLOR(value),
	);

	// Highlight Python keywords
	code = code.replace(/\b([A-Za-z_][\w]*)\b/g, (_m, word) =>
		PY_KEYWORDS.has(word) ? KEYWORD_COLOR(word) : word,
	);

	// Highlight strings (including triple-quoted)
	const stringRegex =
		/("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"])*"|'(?:\\.|[^'])*')/g;
	code = code.replace(stringRegex, (match) => STRING_COLOR(match));

	return indent + code + (comment ? COMMENT_COLOR(comment) : "");
}

/**
 * SQL painter: highlights SQL syntax with uppercase keywords.
 *
 * SQL convention is to uppercase keywords, so we transform
 * matched keywords to uppercase in addition to coloring them.
 */
function paintSql(line: string): string {
	const { indent, body } = stripIndent(line);
	let result = body;

	// Match words and uppercase keywords
	result = result.replace(/\b([a-z]+)\b/gi, (match) =>
		SQL_KEYWORDS.has(match.toLowerCase())
			? KEYWORD_COLOR(match.toUpperCase())
			: match,
	);

	// SQL strings use single quotes (with '' for escaping)
	result = result.replace(/'(?:''|[^'])*'/g, (match) => STRING_COLOR(match));

	// Highlight numbers
	result = result.replace(/\b\d+(?:\.\d+)?\b/g, (match) => NUMBER_COLOR(match));

	return indent + result;
}

/**
 * YAML painter: highlights keys, values, and special literals.
 *
 * YAML structure is `key: value`, so we parse that pattern
 * and color the key in cyan.
 */
function paintYaml(line: string): string {
	const match = line.match(/^(\s*)([^:#]+):(.*)$/);
	if (!match) {
		return DEFAULT_CODE_COLOR(line);
	}

	const [, indent, key, rest] = match;
	let value = rest!.trimStart();

	// Highlight quoted strings in values
	value = value.replace(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'/g, (str) =>
		STRING_COLOR(str),
	);

	// Highlight boolean and null literals
	value = value.replace(/\b(true|false|null)\b/gi, (word) =>
		KEYWORD_COLOR(word),
	);

	return `${indent}${chalk.hex("#7dd3fc")(`${key}:`)}${value ? ` ${value}` : ""}`;
}

// ────────────────────────────────────────────────────────────────────────────
// PAINTER REGISTRY
// Maps language identifiers to their painter functions
// ────────────────────────────────────────────────────────────────────────────

/**
 * Registry of language painters.
 *
 * Each entry has:
 * - matcher: Function to test if a language ID matches
 * - painter: Function to apply highlighting to a line
 *
 * The first matching painter is used, so order matters for
 * overlapping language names.
 */
const PAINTERS: Array<{
	matcher: (lang: string) => boolean;
	painter: Painter;
}> = [
	{ matcher: (lang) => JSON_LANGS.has(lang), painter: paintJson },
	{ matcher: (lang) => SHELL_LANGS.has(lang), painter: paintShell },
	{ matcher: (lang) => DIFF_LANGS.has(lang), painter: paintDiff },
	{
		matcher: (lang) => JS_LANGS.has(lang),
		painter: (line) => paintKeywordLine(line, JS_KEYWORDS),
	},
	{ matcher: (lang) => PY_LANGS.has(lang), painter: paintPython },
	{ matcher: (lang) => SQL_LANGS.has(lang), painter: paintSql },
	{ matcher: (lang) => YAML_LANGS.has(lang), painter: paintYaml },
];

/**
 * Looks up the appropriate painter for a language.
 *
 * @param language - Language identifier (e.g., "typescript", "py", "json")
 * @returns Painter function for the language, or default painter
 */
function getPainter(language?: string): Painter {
	const lang = (language || "").toLowerCase();
	for (const entry of PAINTERS) {
		if (entry.matcher(lang)) {
			return entry.painter;
		}
	}
	return paintDefault;
}

// ────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ────────────────────────────────────────────────────────────────────────────

/**
 * Highlights a multi-line code block.
 *
 * This is the main entry point for syntax highlighting. It:
 * 1. Selects the appropriate painter based on language
 * 2. Normalizes tabs to 2 spaces
 * 3. Applies highlighting line-by-line
 *
 * @param text - Code block content
 * @param language - Optional language identifier
 * @returns Array of ANSI-styled lines
 *
 * @example
 * ```typescript
 * const lines = highlightCodeLines(
 *   'const x = 42;\nconsole.log(x);',
 *   'typescript'
 * );
 * lines.forEach(line => console.log(line));
 * ```
 */
export function highlightCodeLines(text: string, language?: string): string[] {
	const painter = getPainter(language);
	// Normalize tabs to 2 spaces for consistent rendering
	const normalized = text.replace(/\t/g, "  ");
	const lines = normalized.split("\n");
	return lines.map((line) => painter(line));
}

/**
 * Highlights inline code (single backticks in markdown).
 *
 * Uses a dark background with yellow text for visibility.
 * Newlines are converted to spaces since inline code should
 * remain on a single line.
 *
 * @param text - Inline code content
 * @returns ANSI-styled string
 *
 * @example
 * ```typescript
 * const styled = highlightInlineCode('foo.bar()');
 * console.log(`Use ${styled} to call the method`);
 * ```
 */
export function highlightInlineCode(text: string): string {
	if (!text) return "";
	// Replace newlines with spaces (inline code is single-line)
	const cleaned = text.replace(/\r?\n/g, " ");
	// Dark purple background with yellow text
	return chalk.bgRgb(40, 42, 54)(chalk.hex("#facc15")(cleaned));
}
