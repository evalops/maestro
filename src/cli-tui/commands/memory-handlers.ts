/**
 * Command handlers for /memory command.
 *
 * Provides:
 * - /memory save <topic> <content> - Save a memory
 * - /memory search <query> - Search memories
 * - /memory list [topic] - List memories or topics
 * - /memory delete <id|topic> - Delete memory or topic
 * - /memory stats - Show memory statistics
 * - /memory export [path] - Export memories to file
 * - /memory import <path> - Import memories from file
 * - /memory clear - Clear all memories
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import {
	addMemory,
	clearAllMemories,
	deleteMemory,
	deleteTopicMemories,
	ensureTeamMemoryEntrypoint,
	exportMemories,
	getRecentMemories,
	getStats,
	getTeamMemoryStatus,
	getTopicMemories,
	importMemories,
	listTopics,
	searchMemories,
} from "../../memory/index.js";

export interface MemoryRenderContext {
	rawInput: string;
	cwd: string;
	sessionId?: string;
	addContent(content: string): void;
	showError(message: string): void;
	showInfo(message: string): void;
	showSuccess(message: string): void;
	requestRender(): void;
}

/**
 * Format a timestamp as relative time.
 */
function formatRelativeTime(timestamp: number): string {
	const diff = Date.now() - timestamp;
	if (diff < 60000) return "just now";
	if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
	if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
	return `${Math.floor(diff / 86400000)}d ago`;
}

/**
 * Truncate text to a maximum length.
 */
function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.slice(0, maxLen - 3)}...`;
}

/**
 * Parse the /memory command arguments.
 */
function parseMemoryCommand(rawInput: string): {
	subcommand: string;
	args: string[];
	rawArgs: string;
} {
	const withoutCommand = rawInput.replace(/^\/memory\s*/, "").trim();
	const parts = withoutCommand.split(/\s+/);
	const subcommand = parts[0]?.toLowerCase() || "help";
	const args = parts.slice(1);
	const rawArgs = parts.slice(1).join(" ");
	return { subcommand, args, rawArgs };
}

function extractSessionScope(args: string[]): {
	args: string[];
	sessionOnly: boolean;
} {
	let sessionOnly = false;
	const filteredArgs = args.filter((arg) => {
		if (arg === "--session" || arg === "-s") {
			sessionOnly = true;
			return false;
		}
		return true;
	});
	return { args: filteredArgs, sessionOnly };
}

function resolveScopedSessionId(
	ctx: MemoryRenderContext,
	sessionOnly: boolean,
): string | undefined | null {
	if (!sessionOnly) {
		return undefined;
	}
	if (!ctx.sessionId) {
		ctx.showError("Current session required for --session.");
		return null;
	}
	return ctx.sessionId;
}

/**
 * Handle the /memory command.
 */
export function handleMemoryCommand(ctx: MemoryRenderContext): void {
	const { subcommand, args, rawArgs } = parseMemoryCommand(ctx.rawInput);

	switch (subcommand) {
		case "save":
		case "add":
			handleSave(ctx, args, rawArgs);
			break;
		case "session":
			handleRecent(ctx, args[0] ? Number.parseInt(args[0], 10) : 10, {
				sessionId: resolveScopedSessionId(ctx, true),
			});
			break;
		case "search":
		case "find":
			handleSearch(ctx, args);
			break;
		case "list":
		case "ls":
			handleList(ctx, args);
			break;
		case "delete":
		case "rm":
		case "forget":
			handleDelete(ctx, args[0]);
			break;
		case "stats":
		case "status":
			handleStats(ctx, args);
			break;
		case "team":
			handleTeam(ctx, args);
			break;
		case "export":
			handleExport(ctx, args[0]);
			break;
		case "import":
			handleImport(ctx, args[0]);
			break;
		case "clear":
			handleClear(ctx, args.includes("--force") || args.includes("-f"));
			break;
		case "recent":
			{
				const { args: recentArgs, sessionOnly } = extractSessionScope(args);
				handleRecent(
					ctx,
					recentArgs[0] ? Number.parseInt(recentArgs[0], 10) : 10,
					{
						sessionId: resolveScopedSessionId(ctx, sessionOnly),
					},
				);
			}
			break;
		default:
			handleHelp(ctx);
	}
}

function handleSave(
	ctx: MemoryRenderContext,
	args: string[],
	rawArgs: string,
): void {
	const topic = args[0];
	if (!topic || args.length < 2) {
		ctx.showError("Usage: /memory save <topic> <content>");
		return;
	}

	// Extract content - everything after the topic
	const content = rawArgs.replace(topic, "").trim();

	if (!content) {
		ctx.showError("Content cannot be empty");
		return;
	}

	// Extract tags from #hashtags in content
	const tagMatches = content.match(/#(\w+)/g);
	const tags = tagMatches?.map((t) => t.slice(1)) ?? [];

	const entry = addMemory(topic, content, {
		tags,
		sessionId: ctx.sessionId,
		cwd: ctx.cwd,
	});

	ctx.showSuccess(`Memory saved to topic "${topic}" (${entry.id})`);
}

function handleSearch(ctx: MemoryRenderContext, rawArgs: string[]): void {
	const { args, sessionOnly } = extractSessionScope(rawArgs);
	const sessionId = resolveScopedSessionId(ctx, sessionOnly);
	if (sessionId === null) {
		return;
	}
	const query = args.join(" ").trim();
	if (!query) {
		ctx.showError("Usage: /memory search <query> [--session]");
		return;
	}

	const results = searchMemories(query, { limit: 10, sessionId });

	if (results.length === 0) {
		ctx.showInfo(`No memories found for "${query}"`);
		return;
	}

	const lines = [`Search Results for "${query}" (${results.length} found)`, ""];

	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		if (!result) continue;
		const { entry, score, matchedOn } = result;
		const scoreStr = chalk.dim(`[${score.toFixed(1)}]`);
		const topicStr = chalk.cyan(`[${entry.topic}]`);
		const matchStr = chalk.dim(`(${matchedOn})`);

		lines.push(
			`${chalk.dim(`${i + 1}.`)} ${topicStr} ${truncate(entry.content, 60)} ${scoreStr} ${matchStr}`,
		);
		lines.push(
			chalk.dim(`   ID: ${entry.id} • ${formatRelativeTime(entry.updatedAt)}`),
		);
	}

	ctx.addContent(lines.join("\n"));
	ctx.requestRender();
}

function handleList(ctx: MemoryRenderContext, rawArgs: string[]): void {
	const { args, sessionOnly } = extractSessionScope(rawArgs);
	const sessionId = resolveScopedSessionId(ctx, sessionOnly);
	if (sessionId === null) {
		return;
	}
	const topic = args[0];
	if (topic) {
		// List memories for a specific topic
		const memories = getTopicMemories(topic, { sessionId });

		if (memories.length === 0) {
			ctx.showInfo(`No memories found for topic "${topic}"`);
			return;
		}

		const lines = [`Memories in "${topic}" (${memories.length})`, ""];

		for (const entry of memories.slice(0, 20)) {
			const tags = entry.tags?.length
				? chalk.dim(` [${entry.tags.join(", ")}]`)
				: "";
			lines.push(`  ${chalk.dim("•")} ${truncate(entry.content, 70)}${tags}`);
			lines.push(
				chalk.dim(`    ${entry.id} • ${formatRelativeTime(entry.updatedAt)}`),
			);
		}

		if (memories.length > 20) {
			lines.push(chalk.dim(`  ... and ${memories.length - 20} more`));
		}

		ctx.addContent(lines.join("\n"));
		ctx.requestRender();
	} else {
		// List all topics
		const topics = listTopics({ sessionId });

		if (topics.length === 0) {
			ctx.showInfo(
				"No memories saved yet. Use /memory save <topic> <content> to add one.",
			);
			return;
		}

		const lines = [`Memory Topics (${topics.length})`, ""];

		for (const topic of topics) {
			lines.push(
				`  ${chalk.cyan(topic.name)} - ${topic.entryCount} ${topic.entryCount === 1 ? "entry" : "entries"} ${chalk.dim(`(${formatRelativeTime(topic.lastUpdated)})`)}`,
			);
		}

		lines.push("");
		lines.push(chalk.dim("Use /memory list <topic> to see entries"));

		ctx.addContent(lines.join("\n"));
		ctx.requestRender();
	}
}

function handleDelete(ctx: MemoryRenderContext, target?: string): void {
	if (!target) {
		ctx.showError("Usage: /memory delete <id|topic>");
		return;
	}

	// Check if it's an ID (starts with mem_)
	if (target.startsWith("mem_")) {
		const deleted = deleteMemory(target);
		if (deleted) {
			ctx.showSuccess(`Memory ${target} deleted`);
		} else {
			ctx.showError(`Memory ${target} not found`);
		}
	} else {
		// Treat as topic
		const count = deleteTopicMemories(target);
		if (count > 0) {
			ctx.showSuccess(
				`Deleted ${count} ${count === 1 ? "memory" : "memories"} from topic "${target}"`,
			);
		} else {
			ctx.showInfo(`No memories found for topic "${target}"`);
		}
	}
}

function handleStats(ctx: MemoryRenderContext, rawArgs: string[]): void {
	const { sessionOnly } = extractSessionScope(rawArgs);
	const sessionId = resolveScopedSessionId(ctx, sessionOnly);
	if (sessionId === null) {
		return;
	}
	const stats = getStats({ sessionId });

	const lines = ["Memory Statistics", ""];

	lines.push(`  Total entries: ${stats.totalEntries}`);
	lines.push(`  Topics: ${stats.topics}`);

	if (stats.oldestEntry) {
		lines.push(`  Oldest: ${formatRelativeTime(stats.oldestEntry)}`);
	}
	if (stats.newestEntry) {
		lines.push(`  Newest: ${formatRelativeTime(stats.newestEntry)}`);
	}

	ctx.addContent(lines.join("\n"));
	ctx.requestRender();
}

function handleExport(ctx: MemoryRenderContext, path?: string): void {
	const store = exportMemories();
	const outputPath = path
		? resolve(ctx.cwd, path)
		: resolve(ctx.cwd, "maestro-memories.json");

	try {
		writeFileSync(outputPath, JSON.stringify(store, null, 2), "utf-8");
		ctx.showSuccess(
			`Exported ${store.entries.length} memories to ${outputPath}`,
		);
	} catch (error) {
		ctx.showError(
			`Failed to export: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function handleTeam(ctx: MemoryRenderContext, args: string[]): void {
	const action = args[0]?.toLowerCase() ?? "status";

	if (action === "init" || action === "create") {
		const location = ensureTeamMemoryEntrypoint(ctx.cwd);
		if (!location) {
			ctx.showError("Team memory is only available inside a git repository.");
			return;
		}
		ctx.showSuccess(`Team memory ready at ${location.entrypoint}`);
		return;
	}

	const status = getTeamMemoryStatus(ctx.cwd);
	if (!status) {
		ctx.showError("Team memory is only available inside a git repository.");
		return;
	}

	if (action === "path") {
		ctx.showInfo(`Team memory entrypoint: ${status.entrypoint}`);
		return;
	}

	if (action !== "status" && action !== "list") {
		ctx.showError("Usage: /memory team [status|path|init]");
		return;
	}

	const lines = [
		"Team Memory",
		"",
		`  Repo: ${chalk.cyan(status.projectName)}`,
		`  Path: ${status.directory}`,
		`  Status: ${status.exists ? chalk.green("initialized") : chalk.yellow("not initialized")}`,
		`  Files: ${status.fileCount}`,
	];

	if (status.files.length > 0) {
		lines.push("");
		lines.push("Files");
		for (const relativePath of status.files.slice(0, 12)) {
			lines.push(`  ${chalk.dim("•")} ${relativePath}`);
		}
		if (status.files.length > 12) {
			lines.push(chalk.dim(`  ... and ${status.files.length - 12} more`));
		}
	} else {
		lines.push("");
		lines.push(chalk.dim("Run /memory team init to create MEMORY.md."));
	}

	ctx.addContent(lines.join("\n"));
	ctx.requestRender();
}

function handleImport(ctx: MemoryRenderContext, path?: string): void {
	if (!path) {
		ctx.showError("Usage: /memory import <path>");
		return;
	}

	const inputPath = resolve(ctx.cwd, path);

	if (!existsSync(inputPath)) {
		ctx.showError(`File not found: ${inputPath}`);
		return;
	}

	try {
		const content = readFileSync(inputPath, "utf-8");
		const store = JSON.parse(content);

		const result = importMemories(store);
		ctx.showSuccess(
			`Imported: ${result.added} added, ${result.updated} updated, ${result.skipped} skipped`,
		);
	} catch (error) {
		ctx.showError(
			`Failed to import: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function handleClear(ctx: MemoryRenderContext, force: boolean): void {
	if (!force) {
		ctx.showInfo(
			"This will delete ALL memories. Use /memory clear --force to confirm.",
		);
		return;
	}

	const count = clearAllMemories();
	ctx.showSuccess(`Cleared ${count} memories`);
}

function handleRecent(
	ctx: MemoryRenderContext,
	limit: number,
	options?: { sessionId?: string | null },
): void {
	if (options?.sessionId === null) {
		return;
	}
	const memories = getRecentMemories(limit, {
		sessionId: options?.sessionId ?? undefined,
	});

	if (memories.length === 0) {
		ctx.showInfo("No memories saved yet.");
		return;
	}

	const lines = [`Recent Memories (${memories.length})`, ""];

	for (const entry of memories) {
		const topicStr = chalk.cyan(`[${entry.topic}]`);
		lines.push(`  ${topicStr} ${truncate(entry.content, 60)}`);
		lines.push(
			chalk.dim(`    ${entry.id} • ${formatRelativeTime(entry.updatedAt)}`),
		);
	}

	ctx.addContent(lines.join("\n"));
	ctx.requestRender();
}

function handleHelp(ctx: MemoryRenderContext): void {
	const lines = [
		"Memory Commands",
		"",
		"  /memory save <topic> <content>  Save a memory (use #tags for tagging)",
		"  /memory search <query>          Search across all memories",
		"  /memory search <query> --session Search current-session memories",
		"  /memory list                    List all topics",
		"  /memory list <topic>            List memories in a topic",
		"  /memory list --session          List current-session topics",
		"  /memory session [N]             Show recent current-session memories",
		"  /memory recent [N]              Show N most recent memories",
		"  /memory team [status|path|init] Manage repo-scoped team memory",
		"  /memory delete <id|topic>       Delete a memory or topic",
		"  /memory stats                   Show memory statistics",
		"  /memory export [path]           Export to JSON file",
		"  /memory import <path>           Import from JSON file",
		"  /memory clear --force           Clear all memories",
		"",
		"Examples:",
		"  /memory save api-design Use REST conventions #rest #naming",
		"  /memory search REST",
		"  /memory search REST --session",
		"  /memory list api-design",
		"  /memory session 5",
		"  /memory team init",
		"  /memory delete api-design",
	];

	ctx.addContent(lines.join("\n"));
	ctx.requestRender();
}
