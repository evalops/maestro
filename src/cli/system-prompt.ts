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
		process.env.PLAYWRIGHT_AGENT_DIR ??
			process.env.CODING_AGENT_DIR ??
			join(homeDir, ".playwright/agent/"),
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
- read: Read file contents
- bash: Execute bash commands (ls, grep, find, etc.)
- edit: Make surgical edits to files (find exact text and replace)
- write: Create or overwrite files
- list: List files and directories safely using glob patterns
- todo: Produce TodoWrite-style checklists. Provide payload { goal: "...", items: [{ content: "...", status: "pending", priority: "medium" }] } (items may also be a JSON string that parses to that array).

Guidelines:
- Always use bash tool for file operations like ls, grep, find
- Use read to examine files before editing
- Use edit for precise changes (old text must match exactly)
- Use write only for new files or complete rewrites
- Use list to inspect directory structures when you only need filenames
- Use todo when you need a structured task list; supply a goal plus an items array shaped like TodoWrite entries.
- Be concise in your responses
- Show file paths clearly when working with files`;

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
