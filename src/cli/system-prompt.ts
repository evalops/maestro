import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	readSync,
	statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import chalk from "chalk";
import { buildSearchGuidelines } from "../agent/search-guidance.js";
import { PATHS, getAgentDir } from "../config/constants.js";
import { type ComposerConfig, loadConfig } from "../config/index.js";

// Tool descriptions for dynamic system prompt generation
const TOOL_DESCRIPTIONS: Record<string, string> = {
	read: "Read file contents",
	list: "List files and directories safely using glob patterns",
	find: "Fast file search using fd with glob patterns. Respects .gitignore. Use for discovering files across large codebases.",
	search: "Search files with ripgrep (pattern, glob, context options)",
	parallel_ripgrep:
		"Run multiple ripgrep searches in parallel, merge overlapping matches into line ranges, and return their content.",
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

function resolvePromptInput(value?: string): string | null {
	if (!value) return null;
	if (existsSync(value)) {
		try {
			return readFileSync(value, "utf-8");
		} catch (error) {
			console.error(
				chalk.yellow(
					`Warning: Could not read system prompt file ${value}: ${error}`,
				),
			);
			return null;
		}
	}
	return value;
}

function loadAppendSystemPrompt(cwd: string): string | null {
	const projectPath = join(cwd, ".maestro", "APPEND_SYSTEM.md");
	if (existsSync(projectPath)) {
		return resolvePromptInput(projectPath);
	}
	const globalPath = join(getAgentDir(), "APPEND_SYSTEM.md");
	if (existsSync(globalPath)) {
		return resolvePromptInput(globalPath);
	}
	return null;
}

function buildGuidelines(toolNames: Set<string>, currentYear: number): string {
	const guidelines: string[] = [];

	guidelines.push(
		"You can emit multiple tool calls in a single turn; the runtime will execute independent calls in parallel. No batch tool is needed—just include separate tool calls when parallelism helps.",
	);
	guidelines.push(...buildSearchGuidelines(toolNames, currentYear));

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
	guidelines.push(
		'When the user specifies an explicit output token target such as "+500k", "use 2M tokens", or "spend 1B tokens", keep working until you approach that target productively instead of stopping early.',
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

interface ContextFileOptions {
	candidates: string[];
	maxBytes?: number;
}

interface ReadContextResult {
	content: string;
	truncated: boolean;
	bytesRead: number;
	originalSize?: number;
	maxBytes?: number;
}

function truncateUtf8(
	buffer: Buffer,
	maxBytes: number,
): {
	content: string;
	bytes: number;
} {
	let end = Math.min(maxBytes, buffer.length);
	if (end === 0) {
		return { content: "", bytes: 0 };
	}

	let start = end - 1;
	while (start >= 0) {
		const byte = buffer[start];
		if (byte === undefined) {
			return { content: "", bytes: 0 };
		}
		if ((byte & 0b1100_0000) !== 0b1000_0000) {
			break;
		}
		start -= 1;
	}

	if (start < 0) {
		return { content: "", bytes: 0 };
	}

	const lead = buffer[start];
	if (lead === undefined) {
		return { content: "", bytes: 0 };
	}
	let expected = 1;
	if ((lead & 0b1000_0000) === 0) {
		expected = 1;
	} else if ((lead & 0b1110_0000) === 0b1100_0000) {
		expected = 2;
	} else if ((lead & 0b1111_0000) === 0b1110_0000) {
		expected = 3;
	} else if ((lead & 0b1111_1000) === 0b1111_0000) {
		expected = 4;
	} else {
		end = start;
	}

	if (start + expected > end) {
		end = start;
	}

	const slice = buffer.slice(0, Math.max(0, end));
	return { content: slice.toString("utf-8"), bytes: slice.length };
}

function readContextFile(
	filePath: string,
	maxBytes?: number,
): ReadContextResult | null {
	if (maxBytes !== undefined && maxBytes > 0) {
		const stats = statSync(filePath);
		if (stats.size > maxBytes) {
			const fd = openSync(filePath, "r");
			try {
				const buffer = Buffer.alloc(maxBytes);
				const bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
				const truncated = truncateUtf8(buffer, bytesRead);
				return {
					content: truncated.content,
					truncated: true,
					bytesRead: truncated.bytes,
					originalSize: stats.size,
					maxBytes,
				};
			} finally {
				closeSync(fd);
			}
		}
	}
	const content = readFileSync(filePath, "utf-8");
	return {
		content,
		truncated: false,
		bytesRead: Buffer.byteLength(content),
	};
}

interface ContextFileLoadResult {
	file: ContextFile;
	bytesRead: number;
}

function loadContextFileFromDir(
	dir: string,
	options: ContextFileOptions & { remainingBytes?: number },
): ContextFileLoadResult | null {
	const { candidates, maxBytes, remainingBytes } = options;
	const budget = remainingBytes ?? maxBytes;
	if (budget !== undefined && budget <= 0) {
		return null;
	}
	for (const filename of candidates) {
		const filePath = join(dir, filename);
		if (existsSync(filePath)) {
			try {
				const result = readContextFile(filePath, budget);
				if (!result) return null;
				const note = result.truncated
					? `\n\n[Truncated to ${result.bytesRead} bytes from ${result.originalSize} bytes.]`
					: "";
				return {
					file: {
						path: filePath,
						content: `${result.content}${note}`,
					},
					bytesRead: result.bytesRead,
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

function resolveContextCandidates(config?: ComposerConfig): string[] {
	const fallback = config?.project_doc_fallback_filenames ?? [];
	const merged = [...PATHS.AGENT_CONTEXT_FILES, ...fallback];
	return Array.from(new Set(merged));
}

export function loadProjectContextFiles(
	cwdOverride?: string,
	options: { config?: ComposerConfig } = {},
): ContextFile[] {
	const contextFiles: ContextFile[] = [];

	const cwd = cwdOverride ?? process.cwd();
	const config = options.config ?? loadConfig(cwd);
	const candidates = resolveContextCandidates(config);
	const maxBytesRaw = config.project_doc_max_bytes;
	const maxBytes =
		typeof maxBytesRaw === "number"
			? Math.max(0, Math.floor(maxBytesRaw))
			: undefined;
	let remainingBytes = maxBytes;
	if (remainingBytes === 0) {
		return contextFiles;
	}

	const globalContextDir = resolve(getAgentDir());
	const globalContext = loadContextFileFromDir(globalContextDir, {
		candidates,
		maxBytes,
		remainingBytes,
	});
	if (globalContext) {
		contextFiles.push(globalContext.file);
		if (remainingBytes !== undefined) {
			remainingBytes = Math.max(0, remainingBytes - globalContext.bytesRead);
		}
	}

	const directories: string[] = [];
	let currentDir = cwd;
	const root = resolve("/");

	while (true) {
		directories.push(currentDir);
		if (currentDir === root) break;

		const parentDir = resolve(currentDir, "..");
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	directories.reverse();

	for (const dir of directories) {
		if (remainingBytes === 0) break;
		const contextFile = loadContextFileFromDir(dir, {
			candidates,
			maxBytes,
			remainingBytes,
		});
		if (contextFile) {
			contextFiles.push(contextFile.file);
			if (remainingBytes !== undefined) {
				remainingBytes = Math.max(0, remainingBytes - contextFile.bytesRead);
			}
		}
	}

	return contextFiles;
}

// Default tool names when no filter is applied
const DEFAULT_TOOL_NAMES = [
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
	appendPrompt?: string,
): string {
	const cwd = process.cwd();
	const promptSource = resolvePromptInput(customPrompt);
	const appendSource =
		resolvePromptInput(appendPrompt) ?? loadAppendSystemPrompt(cwd);
	const appendText = appendSource?.trim();

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

		if (appendText) {
			prompt += "\n\n# Additional System Instructions\n\n";
			prompt += `${appendText}\n\n`;
		}

		prompt += `\nCurrent date and time: ${dateTime}`;
		prompt += `\nCurrent working directory: ${cwd}`;

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
	const currentYear = now.getFullYear();

	// Use provided tool names or default
	const activeToolNames = toolNames ?? DEFAULT_TOOL_NAMES;
	const toolNameSet = new Set(activeToolNames);

	let prompt = `You are an expert coding assistant. You help users with coding tasks by reading files, executing commands, editing code, and writing new files.

${buildToolsSection(activeToolNames)}

${buildGuidelines(toolNameSet, currentYear)}`;

	const contextFiles = loadProjectContextFiles();
	if (contextFiles.length > 0) {
		prompt += "\n\n# Project Context\n\n";
		prompt += "The following project context files have been loaded:\n\n";
		for (const { path, content } of contextFiles) {
			prompt += `## ${path}\n\n${content}\n\n`;
		}
	}

	if (appendText) {
		prompt += "\n\n# Additional System Instructions\n\n";
		prompt += `${appendText}\n\n`;
	}

	prompt += `\nCurrent date and time: ${dateTime}`;
	prompt += `\nCurrent working directory: ${cwd}`;

	return prompt;
}
