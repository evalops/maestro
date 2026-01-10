import chalk from "chalk";

type Painter = (line: string) => string;

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

const DEFAULT_CODE_COLOR = chalk.hex("#e2e8f0");
const COMMENT_COLOR = chalk.hex("#94a3b8");
const KEYWORD_COLOR = chalk.hex("#f472b6");
const NUMBER_COLOR = chalk.hex("#fcd34d");
const STRING_COLOR = chalk.hex("#f9a8d4");
const DIFF_ADD = chalk.hex("#4ade80");
const DIFF_REMOVE = chalk.hex("#f87171");
const DIFF_META = chalk.hex("#38bdf8");
const SHELL_CMD = chalk.hex("#93c5fd").bold;
const SHELL_FLAG = chalk.hex("#fcd34d");

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

function stripIndent(line: string): { indent: string; body: string } {
	const match = line.match(/^\s*/);
	const indent = match ? match[0] : "";
	return { indent, body: line.slice(indent.length) };
}

function paintDefault(line: string): string {
	if (!line) return "";
	return DEFAULT_CODE_COLOR(line);
}

function paintJson(line: string): string {
	const { indent, body } = stripIndent(line);
	let result = body;
	result = result.replace(/"([^"]*)"(?=\s*:)/g, (_match, key) =>
		chalk.hex("#7dd3fc")(`"${key}"`),
	);
	result = result.replace(
		/:\s*("[^"]*")/g,
		(_m, value) => `: ${STRING_COLOR(value)}`,
	);
	result = result.replace(
		/:\s*(-?\d+(?:\.\d+)?)/g,
		(_m, value) => `: ${NUMBER_COLOR(value)}`,
	);
	result = result.replace(/\b(true|false|null)\b/g, (_m, val) =>
		chalk.hex("#34d399")(val),
	);
	return indent + result;
}

function paintShell(line: string): string {
	const { indent, body } = stripIndent(line);
	const trimmed = body.trim();
	if (!trimmed) return indent;
	if (trimmed.startsWith("#")) {
		return indent + COMMENT_COLOR(trimmed);
	}
	const parts = trimmed.split(/\s+/);
	const [command, ...rest] = parts;
	let restJoined = rest.join(" ");
	restJoined = restJoined.replace(/(--[\w-]+)/g, (_m, flag) =>
		SHELL_FLAG(flag),
	);
	restJoined = restJoined.replace(/\b(-[\w])\b/g, (_m, flag) =>
		SHELL_FLAG(flag),
	);
	return indent + SHELL_CMD(command) + (restJoined ? ` ${restJoined}` : "");
}

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

function paintKeywordLine(line: string, keywords: Set<string>): string {
	const { indent, body } = stripIndent(line);
	if (!body) return indent;
	const commentIndex = body.indexOf("//");
	let code = commentIndex >= 0 ? body.slice(0, commentIndex) : body;
	const comment = commentIndex >= 0 ? body.slice(commentIndex) : "";
	code = code.replace(/\b(\d+(?:\.\d+)?)\b/g, (_m, value) =>
		NUMBER_COLOR(value),
	);
	code = code.replace(/\b([A-Za-z_][\w]*)\b/g, (_m, word) =>
		keywords.has(word) ? KEYWORD_COLOR(word) : word,
	);
	const stringRegex = /("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`)/g;
	code = code.replace(stringRegex, (match) => STRING_COLOR(match));
	return indent + code + (comment ? COMMENT_COLOR(comment) : "");
}

function paintPython(line: string): string {
	const { indent, body } = stripIndent(line);
	if (!body) return indent;
	const commentIndex = body.indexOf("#");
	let code = commentIndex >= 0 ? body.slice(0, commentIndex) : body;
	const comment = commentIndex >= 0 ? body.slice(commentIndex) : "";
	code = code.replace(/\b(\d+(?:\.\d+)?)\b/g, (_m, value) =>
		NUMBER_COLOR(value),
	);
	code = code.replace(/\b([A-Za-z_][\w]*)\b/g, (_m, word) =>
		PY_KEYWORDS.has(word) ? KEYWORD_COLOR(word) : word,
	);
	const stringRegex =
		/("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"])*"|'(?:\\.|[^'])*')/g;
	code = code.replace(stringRegex, (match) => STRING_COLOR(match));
	return indent + code + (comment ? COMMENT_COLOR(comment) : "");
}

function paintSql(line: string): string {
	const { indent, body } = stripIndent(line);
	let result = body;
	result = result.replace(/\b([a-z]+)\b/gi, (match) =>
		SQL_KEYWORDS.has(match.toLowerCase())
			? KEYWORD_COLOR(match.toUpperCase())
			: match,
	);
	result = result.replace(/'(?:''|[^'])*'/g, (match) => STRING_COLOR(match));
	result = result.replace(/\b\d+(?:\.\d+)?\b/g, (match) => NUMBER_COLOR(match));
	return indent + result;
}

function paintYaml(line: string): string {
	const match = line.match(/^(\s*)([^:#]+):(.*)$/);
	if (!match) {
		return DEFAULT_CODE_COLOR(line);
	}
	const [, indent, key, rest] = match;
	if (rest === undefined) return DEFAULT_CODE_COLOR(line);
	let value = rest.trimStart();
	value = value.replace(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'/g, (str) =>
		STRING_COLOR(str),
	);
	value = value.replace(/\b(true|false|null)\b/gi, (word) =>
		KEYWORD_COLOR(word),
	);
	return `${indent}${chalk.hex("#7dd3fc")(`${key}:`)}${value ? ` ${value}` : ""}`;
}

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

function getPainter(language?: string): Painter {
	const lang = (language || "").toLowerCase();
	for (const entry of PAINTERS) {
		if (entry.matcher(lang)) {
			return entry.painter;
		}
	}
	return paintDefault;
}

export function highlightCodeLines(text: string, language?: string): string[] {
	const painter = getPainter(language);
	const normalized = text.replace(/\t/g, "  ");
	const lines = normalized.split("\n");
	return lines.map((line) => painter(line));
}

export function highlightInlineCode(text: string): string {
	if (!text) return "";
	const cleaned = text.replace(/\r?\n/g, " ");
	return chalk.bgRgb(40, 42, 54)(chalk.hex("#facc15")(cleaned));
}
