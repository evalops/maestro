/**
 * Plan Parser
 *
 * Parses markdown plan files into structured tasks for swarm execution.
 * Supports various markdown formats for task lists.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createLogger } from "../../utils/logger.js";
import type { ParsedPlan, SwarmTask } from "./types.js";

const logger = createLogger("agent:swarm:plan-parser");

/**
 * Task item extracted from markdown.
 */
interface RawTask {
	text: string;
	completed: boolean;
	indent: number;
	lineNumber: number;
}

/**
 * Parse a plan file into structured tasks.
 */
export function parsePlanFile(filePath: string): ParsedPlan {
	const content = readFileSync(filePath, "utf-8");
	return parsePlanContent(content);
}

/**
 * Parse plan content (markdown string) into structured tasks.
 */
export function parsePlanContent(content: string): ParsedPlan {
	const lines = content.split("\n");
	const rawTasks: RawTask[] = [];
	let title = "Implementation Plan";

	// Extract title from first H1
	for (const line of lines) {
		const h1Match = line.match(/^#\s+(?:Plan:\s*)?(.+)$/);
		if (h1Match) {
			title = h1Match[1].trim();
			break;
		}
	}

	// Extract tasks from checkbox items and numbered lists
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// Match checkbox items: - [ ] task or - [x] task
		const checkboxMatch = line.match(/^(\s*)[-*]\s*\[([ xX])\]\s*(.+)$/);
		if (checkboxMatch) {
			rawTasks.push({
				text: checkboxMatch[3].trim(),
				completed: checkboxMatch[2].toLowerCase() === "x",
				indent: checkboxMatch[1].length,
				lineNumber: i + 1,
			});
			continue;
		}

		// Match numbered list items: 1. task or 1) task
		const numberedMatch = line.match(/^(\s*)\d+[.)]\s+(.+)$/);
		if (numberedMatch) {
			// Skip if it's a sub-item description
			const text = numberedMatch[2].trim();
			if (
				!text.startsWith("**") &&
				!text.match(/^[A-Z].*:$/) &&
				text.length > 10
			) {
				rawTasks.push({
					text,
					completed: false,
					indent: numberedMatch[1].length,
					lineNumber: i + 1,
				});
			}
			continue;
		}

		// Match bullet items that look like tasks (starts with verb or "Add/Create/Implement")
		const bulletMatch = line.match(/^(\s*)[-*]\s+(.+)$/);
		if (bulletMatch) {
			const text = bulletMatch[2].trim();
			const isTask = isLikelyTask(text);
			if (isTask && !text.startsWith("[") && text.length > 10) {
				rawTasks.push({
					text,
					completed: false,
					indent: bulletMatch[1].length,
					lineNumber: i + 1,
				});
			}
		}
	}

	// Convert raw tasks to SwarmTasks
	const tasks = rawTasks
		.filter((t) => !t.completed) // Only include incomplete tasks
		.map((raw, index) => convertToSwarmTask(raw, index, rawTasks));

	logger.debug("Parsed plan", {
		title,
		totalRawTasks: rawTasks.length,
		incompleteTasks: tasks.length,
	});

	return {
		title,
		tasks,
		content,
	};
}

/**
 * Check if text looks like a task (starts with action verb).
 */
function isLikelyTask(text: string): boolean {
	const actionVerbs = [
		"add",
		"create",
		"implement",
		"update",
		"modify",
		"change",
		"fix",
		"remove",
		"delete",
		"refactor",
		"extract",
		"move",
		"rename",
		"write",
		"build",
		"configure",
		"setup",
		"set up",
		"install",
		"integrate",
		"connect",
		"test",
		"verify",
		"validate",
		"check",
		"ensure",
		"make",
		"define",
		"declare",
		"export",
		"import",
	];

	const lowerText = text.toLowerCase();
	return actionVerbs.some(
		(verb) => lowerText.startsWith(verb) || lowerText.startsWith(`${verb} `),
	);
}

/**
 * Convert a raw task to a SwarmTask.
 */
function convertToSwarmTask(
	raw: RawTask,
	index: number,
	allTasks: RawTask[],
): SwarmTask {
	const task: SwarmTask = {
		id: `task-${index + 1}-${randomUUID().slice(0, 8)}`,
		prompt: raw.text,
		priority: allTasks.length - index, // Earlier tasks have higher priority
	};

	// Extract file references from the task text
	const files = extractFileReferences(raw.text);
	if (files.length > 0) {
		task.files = files;
	}

	// Check for dependency markers
	const deps = extractDependencies(raw.text, index, allTasks);
	if (deps.length > 0) {
		task.dependsOn = deps;
	}

	return task;
}

/**
 * Extract file path references from task text.
 */
function extractFileReferences(text: string): string[] {
	const files: string[] = [];

	// Match quoted paths
	const quotedMatches = text.matchAll(/["'`]([^"'`]+\.[a-z]+)["'`]/gi);
	for (const match of quotedMatches) {
		files.push(match[1]);
	}

	// Match backtick code spans with paths
	const codeMatches = text.matchAll(/`([^`]+\.[a-z]+)`/gi);
	for (const match of codeMatches) {
		if (!files.includes(match[1])) {
			files.push(match[1]);
		}
	}

	// Match common file patterns
	const pathMatches = text.matchAll(
		/\b((?:src|lib|test|tests|packages?)\/[^\s,)]+\.[a-z]+)\b/gi,
	);
	for (const match of pathMatches) {
		if (!files.includes(match[1])) {
			files.push(match[1]);
		}
	}

	return files;
}

/**
 * Extract task dependencies from text.
 */
function extractDependencies(
	text: string,
	currentIndex: number,
	allTasks: RawTask[],
): string[] {
	const deps: string[] = [];
	const lowerText = text.toLowerCase();

	// Check for "after" references
	const afterMatch = lowerText.match(/after\s+(?:task\s+)?(\d+)/);
	if (afterMatch) {
		const depIndex = Number.parseInt(afterMatch[1], 10) - 1;
		if (depIndex >= 0 && depIndex < currentIndex) {
			deps.push(`task-${depIndex + 1}`);
		}
	}

	// Check for "depends on" references
	const dependsMatch = lowerText.match(/depends\s+on\s+(?:task\s+)?(\d+)/);
	if (dependsMatch) {
		const depIndex = Number.parseInt(dependsMatch[1], 10) - 1;
		if (depIndex >= 0 && depIndex < currentIndex) {
			deps.push(`task-${depIndex + 1}`);
		}
	}

	return deps;
}

/**
 * Generate a plan markdown template.
 */
export function generatePlanTemplate(name: string, tasks: string[]): string {
	const timestamp = new Date().toISOString();
	let content = `# Plan: ${name}\n\n`;
	content += `Created: ${timestamp}\n\n`;
	content += "## Tasks\n\n";

	for (let i = 0; i < tasks.length; i++) {
		content += `- [ ] ${tasks[i]}\n`;
	}

	content += "\n## Notes\n\n";
	content += "<!-- Add any additional notes or context here -->\n";

	return content;
}

/**
 * Update a plan file by marking tasks as complete.
 */
export function markTasksComplete(
	content: string,
	completedTaskTexts: string[],
): string {
	let updated = content;

	for (const taskText of completedTaskTexts) {
		// Escape special regex characters in task text
		const escaped = taskText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const pattern = new RegExp(`^(\\s*[-*]\\s*)\\[ \\](\\s*${escaped})`, "gm");
		updated = updated.replace(pattern, "$1[x]$2");
	}

	return updated;
}
