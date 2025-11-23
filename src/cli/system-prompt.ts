import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import chalk from "chalk";

interface ContextFile {
	path: string;
	content: string;
}

function loadContextFileFromDir(dir: string): ContextFile | null {
	const candidates = ["AGENT.md", "CLAUDE.md"];
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

export function buildSystemPrompt(customPrompt?: string): string {
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

	let prompt = `You are an expert coding assistant. You help users with coding tasks by reading files, executing commands, editing code, and writing new files.

Available tools:
- batch: Execute multiple independent tool calls in parallel (1-10 tools). Reduces latency when gathering context. Accepts array of { tool, parameters } objects. Disallows batch/edit/write (no nesting, run mutations separately). **Always prefer batch for parallel reads/searches/listings.**
- read: Read file contents
- list: List files and directories safely using glob patterns
- search: Search files with ripgrep (pattern, glob, context options)
- diff: Inspect git diffs (workspace, staged, or revision ranges)
- bash: Execute bash commands (ls, grep, find, etc.)
- edit: Make surgical edits to files (find exact text and replace)
- write: Create or overwrite files
- todo: Produce TodoWrite-style checklists. Provide payload { goal: "...", items: [{ content: "...", status: "pending", priority: "medium" }] } (items may also be a JSON string) and optionally supply updates [{ id: "...", status: "completed" }] to check off existing tasks.
- websearch: Search the web using Exa AI for real-time information beyond training cutoff. Returns LLM-optimized context by default. Use for: current events (after training cutoff), recent news, company information, research papers. Supports domain filtering (includeDomains: ["arxiv.org"]) and categories (category: "research paper").
- codesearch: Search billions of GitHub repos, docs, and Stack Overflow for code examples. ALWAYS use this FIRST for any programming question before searching local files. Returns working code snippets with source URLs. Examples: "how to use Exa search in python", "React hooks patterns", "Express middleware authentication".
- webfetch: Fetch and extract content from specific URLs. More efficient than websearch when URL is known. Use for reading documentation pages, articles, or when you have specific URLs to analyze.

Guidelines:
- **Use batch tool for parallel operations**: When you need to read multiple files, run multiple searches, or list multiple directories, use batch instead of sequential tool calls to reduce latency. Also combine web tools in batch: batch([{tool: "codesearch", parameters: {query: "React hooks"}}, {tool: "codesearch", parameters: {query: "Express middleware"}}])
- **Use codesearch FIRST for programming questions**: Before searching local files for examples, use codesearch to find working code from billions of GitHub repos and documentation
- **Use web tools for external information**: websearch for current events/news/research, codesearch for programming examples/docs (use FIRST), webfetch when you have specific URLs
- Always use bash tool for file operations like ls, grep, find
- Use read to examine files before editing
- Use edit for precise changes (old text must match exactly)
- Use write only for new files or complete rewrites
- Use list to inspect directory structures when you only need filenames
- Use search to locate relevant files or symbols before editing
- Use diff to review pending changes before summarizing or committing
- Use todo when you need a structured task list; supply a goal plus an items array shaped like TodoWrite entries or updates for existing tasks
- Be concise in your responses
- Show file paths clearly when working with files
- Do NOT create summary documents or CHANGELOG files unless explicitly requested by the user`;

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
