import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import chalk from "chalk";

// Tool descriptions for dynamic system prompt generation
const TOOL_DESCRIPTIONS: Record<string, string> = {
	batch:
		"Execute multiple independent tool calls in parallel (1-10 tools). Reduces latency when gathering context. Accepts array of { tool, parameters } objects. Disallows batch/edit/write (no nesting, run mutations separately). **Always prefer batch for parallel reads/searches/listings.**",
	read: "Read file contents",
	list: "List files and directories safely using glob patterns",
	find: "Fast file search using fd with glob patterns. Respects .gitignore. Use for discovering files across large codebases.",
	search: "Search files with ripgrep (pattern, glob, context options)",
	diff: "Inspect git diffs (workspace, staged, or revision ranges)",
	bash: "Execute bash commands (ls, grep, find, etc.)",
	background_tasks:
		"Launch and manage long-running commands asynchronously. `start` requires `command` (optional `cwd`, `env`, `shell`, per-task `limits`, and `restart={maxAttempts, delayMs, strategy?, maxDelayMs?, jitterRatio?}`), `stop`/`logs` require `taskId`, and `logs` accepts `lines` (default 40).",
	edit: "Make surgical edits to files (find exact text and replace)",
	write: "Create or overwrite files",
	todo: 'Produce TodoWrite-style checklists. Provide payload { goal: "...", items: [{ content: "...", status: "pending", priority: "medium" }] } (items may also be a JSON string) and optionally supply updates [{ id: "...", status: "completed" }] to check off existing tasks.',
	websearch:
		'Search the web using Exa AI for real-time information beyond training cutoff. Returns LLM-optimized context by default. Use for: current events (after training cutoff), recent news, company information, research papers. Supports domain filtering (includeDomains: ["arxiv.org"]) and categories (category: "research paper").',
	codesearch:
		'Search billions of GitHub repos, docs, and Stack Overflow for code examples. ALWAYS use this FIRST for any programming question before searching local files. Returns working code snippets with source URLs. Examples: "how to use Exa search in python", "React hooks patterns", "Express middleware authentication".',
	webfetch:
		"Fetch and extract content from specific URLs. More efficient than websearch when URL is known. Use for reading documentation pages, articles, or when you have specific URLs to analyze.",
	status: "Get git repository status and information",
	gh_pr: "Manage GitHub Pull Requests using gh CLI",
	gh_issue: "Manage GitHub Issues using gh CLI",
	gh_repo: "Manage GitHub Repositories using gh CLI",
};

function buildToolsSection(toolNames: string[]): string {
	const lines = ["Available tools:"];
	for (const name of toolNames) {
		const desc = TOOL_DESCRIPTIONS[name];
		if (desc) {
			lines.push(`- ${name}: ${desc}`);
		}
	}
	return lines.join("\n");
}

function buildGuidelines(toolNames: Set<string>): string {
	const guidelines: string[] = [];

	if (toolNames.has("batch")) {
		guidelines.push(
			"**Use batch tool for parallel operations**: When you need to read multiple files, run multiple searches, or list multiple directories, use batch instead of sequential tool calls to reduce latency.",
		);
	}

	if (toolNames.has("codesearch")) {
		guidelines.push(
			"**Use codesearch FIRST for programming questions**: Before searching local files for examples, use codesearch to find working code from billions of GitHub repos and documentation",
		);
	}

	if (
		toolNames.has("websearch") ||
		toolNames.has("codesearch") ||
		toolNames.has("webfetch")
	) {
		guidelines.push(
			"**Use web tools for external information**: websearch for current events/news/research, codesearch for programming examples/docs, webfetch when you have specific URLs",
		);
	}

	if (toolNames.has("bash")) {
		guidelines.push(
			"Always use bash tool for file operations like ls, grep, find",
		);
		guidelines.push(
			"Destructive commands (e.g., `rm -rf`, `mkfs`, `dd if=/dev/zero`, `chmod 000`) always require manual approval—even through `background_tasks`—so only run them when absolutely necessary",
		);
	}

	if (toolNames.has("background_tasks")) {
		guidelines.push(
			"Running `background_tasks` with `shell: true` requires approval because it enables pipes/redirects/globbing; prefer direct exec unless shell mode is unavoidable",
		);
	}

	if (toolNames.has("read")) {
		guidelines.push("Use read to examine files before editing");
	}

	if (toolNames.has("edit")) {
		guidelines.push(
			"Use edit for precise changes (old text must match exactly)",
		);
	}

	if (toolNames.has("write")) {
		guidelines.push("Use write only for new files or complete rewrites");
	}

	if (toolNames.has("list")) {
		guidelines.push(
			"Use list to inspect directory structures when you only need filenames",
		);
	}

	if (toolNames.has("find")) {
		guidelines.push(
			"Use find for fast file discovery with glob patterns across large codebases",
		);
	}

	if (toolNames.has("search")) {
		guidelines.push(
			"Use search to locate relevant files or symbols before editing",
		);
	}

	if (toolNames.has("diff")) {
		guidelines.push(
			"Use diff to review pending changes before summarizing or committing",
		);
	}

	// Only add validation guidance if mutation tools are available
	if (
		toolNames.has("edit") ||
		toolNames.has("write") ||
		toolNames.has("bash")
	) {
		guidelines.push(
			"After finishing any non-trivial set of code changes, run all required project validators (lint, tests, evals, etc.) before summarizing or committing unless the user explicitly waives them",
		);
	}

	if (toolNames.has("todo")) {
		guidelines.push(
			"Use todo when you need a structured task list; supply a goal plus an items array shaped like TodoWrite entries or updates for existing tasks",
		);
	}

	// Always include these
	guidelines.push("Be concise in your responses");
	guidelines.push("Show file paths clearly when working with files");
	guidelines.push(
		"When evaluating new features, use precise, technical language",
	);
	guidelines.push("Avoid unnecessary emojis unless humor improves clarity");
	guidelines.push(
		"Do NOT create summary documents or CHANGELOG files unless explicitly requested by the user",
	);

	return `Guidelines:\n${guidelines.map((g) => `- ${g}`).join("\n")}`;
}

interface ContextFile {
	path: string;
	content: string;
}

const CONTEXT_FILE_CANDIDATES = [
	"AGENTS.override.md",
	"AGENTS.md",
	"AGENT.md",
	"CLAUDE.md",
];

function loadContextFileFromDir(dir: string): ContextFile | null {
	const candidates = CONTEXT_FILE_CANDIDATES;
	for (const filename of candidates) {
		const filePath = join(dir, filename);
		if (existsSync(filePath)) {
			try {
				return {
					path: filePath,
					content: readFileSync(filePath, "utf-8"),
				};
			} catch (error) {
				console.error(
					chalk.yellow(`Warning: Could not read ${filePath}: ${error}`),
				);
			}
		}
	}
	return null;
}

export function loadProjectContextFiles(): ContextFile[] {
	const contextFiles: ContextFile[] = [];

	const homeDir = homedir();
	const globalContextDir = resolve(
		process.env.COMPOSER_AGENT_DIR ??
			process.env.PLAYWRIGHT_AGENT_DIR ??
			process.env.CODING_AGENT_DIR ??
			join(homeDir, ".composer/agent/"),
	);
	const globalContext = loadContextFileFromDir(globalContextDir);
	if (globalContext) {
		contextFiles.push(globalContext);
	}

	const cwd = process.cwd();
	const ancestorContextFiles: ContextFile[] = [];

	let currentDir = cwd;
	const root = resolve("/");

	while (true) {
		const contextFile = loadContextFileFromDir(currentDir);
		if (contextFile) {
			ancestorContextFiles.unshift(contextFile);
		}

		if (currentDir === root) break;

		const parentDir = resolve(currentDir, "..");
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	contextFiles.push(...ancestorContextFiles);

	return contextFiles;
}

// Default tool names when no filter is applied
const DEFAULT_TOOL_NAMES = [
	"batch",
	"read",
	"list",
	"find",
	"search",
	"diff",
	"bash",
	"background_tasks",
	"edit",
	"write",
	"todo",
	"websearch",
	"codesearch",
	"webfetch",
	"status",
	"gh_pr",
	"gh_issue",
	"gh_repo",
];

export function buildSystemPrompt(
	customPrompt?: string,
	toolNames?: string[],
): string {
	let promptSource = customPrompt;

	if (promptSource && existsSync(promptSource)) {
		try {
			promptSource = readFileSync(promptSource, "utf-8");
		} catch (error) {
			console.error(
				chalk.yellow(
					`Warning: Could not read system prompt file ${promptSource}: ${error}`,
				),
			);
		}
	}

	if (promptSource) {
		const now = new Date();
		const dateTime = now.toLocaleString("en-US", {
			weekday: "long",
			year: "numeric",
			month: "long",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			timeZoneName: "short",
		});

		let prompt = promptSource;

		const contextFiles = loadProjectContextFiles();
		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			prompt += "The following project context files have been loaded:\n\n";
			for (const { path, content } of contextFiles) {
				prompt += `## ${path}\n\n${content}\n\n`;
			}
		}

		prompt += `\nCurrent date and time: ${dateTime}`;
		prompt += `\nCurrent working directory: ${process.cwd()}`;

		return prompt;
	}

	const now = new Date();
	const dateTime = now.toLocaleString("en-US", {
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		timeZoneName: "short",
	});

	// Use provided tool names or default
	const activeToolNames = toolNames ?? DEFAULT_TOOL_NAMES;
	const toolNameSet = new Set(activeToolNames);

	let prompt = `You are an expert coding assistant. You help users with coding tasks by reading files, executing commands, editing code, and writing new files.

${buildToolsSection(activeToolNames)}

${buildGuidelines(toolNameSet)}`;

	const contextFiles = loadProjectContextFiles();
	if (contextFiles.length > 0) {
		prompt += "\n\n# Project Context\n\n";
		prompt += "The following project context files have been loaded:\n\n";
		for (const { path, content } of contextFiles) {
			prompt += `## ${path}\n\n${content}\n\n`;
		}
	}

	prompt += `\nCurrent date and time: ${dateTime}`;
	prompt += `\nCurrent working directory: ${process.cwd()}`;

	return prompt;
}
