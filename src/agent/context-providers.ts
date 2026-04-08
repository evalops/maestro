import {
	getFrameworkSummary,
	resolveFrameworkPreference,
} from "../config/framework.js";
import { getLspConfig } from "../config/lsp-config.js";
import { type IDEInfo, getPrimaryIDE } from "../ide/auto-connect.js";
import { collectDiagnostics, getClients } from "../lsp/index.js";
import { buildTeamMemoryPromptContext } from "../memory/team-memory.js";
import { formatTaskFailures } from "../tools/background-tasks.js";
import {
	formatGoalSection,
	formatSummarySection,
	formatTodosSection,
	loadStore,
} from "../tools/todo.js";
import { getGitSnapshot } from "../utils/git.js";
import { createLogger } from "../utils/logger.js";
import { isWithinCwd } from "../utils/path-validation.js";
import type { AgentContextSource } from "./context-manager.js";

const logger = createLogger("context-providers");

function getLocalIsoDate(now: Date = new Date()): string {
	const timezoneOffsetMs = now.getTimezoneOffset() * 60_000;
	return new Date(now.getTime() - timezoneOffsetMs).toISOString().slice(0, 10);
}

export class TodoContextSource implements AgentContextSource {
	name = "todo";

	async getSystemPromptAdditions(): Promise<string | null> {
		try {
			const store = await loadStore();
			// Find the most recently updated goal
			const goals = Object.values(store).sort((a, b) => {
				return (
					new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
				);
			});
			const activeGoal = goals[0];

			if (!activeGoal) {
				return null;
			}

			const counts = activeGoal.items.reduce(
				(acc, item) => {
					acc[item.status] += 1;
					acc.total += 1;
					return acc;
				},
				{ pending: 0, in_progress: 0, completed: 0, total: 0 } as Record<
					"pending" | "in_progress" | "completed" | "total",
					number
				>,
			);

			// Only show if there are incomplete tasks or it was recently updated
			if (counts.total > 0 && counts.completed < counts.total) {
				const summary = formatSummarySection(counts);
				const todos = formatTodosSection(activeGoal.items);
				return `# Current Task Context\n${formatGoalSection(activeGoal.goal)}\n\n${summary}\n\n${todos}`;
			}

			return null;
		} catch (error) {
			logger.warn("Failed to load todo context", {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			return null;
		}
	}
}

export class BackgroundTaskContextSource implements AgentContextSource {
	name = "background-tasks";

	async getSystemPromptAdditions(): Promise<string | null> {
		try {
			return formatTaskFailures();
		} catch (error) {
			logger.warn("Failed to load background task context", {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			return null;
		}
	}
}

export class GitSnapshotContextSource implements AgentContextSource {
	name = "git-snapshot";
	cacheScope = "session" as const;

	constructor(private readonly cwd: string = process.cwd()) {}

	async getSystemPromptAdditions(): Promise<string | null> {
		return getGitSnapshot(this.cwd);
	}
}

export class CurrentDateContextSource implements AgentContextSource {
	name = "current-date";
	cacheScope = "session" as const;

	async getSystemPromptAdditions(): Promise<string | null> {
		return `Today's date is ${getLocalIsoDate()}.`;
	}
}

export class LspContextSource implements AgentContextSource {
	name = "lsp";

	async getSystemPromptAdditions(): Promise<string | null> {
		try {
			// Check if we have any active clients
			const clients = await getClients();
			if (clients.length === 0) {
				return null;
			}

			// Collect diagnostics from all active clients
			const allDiagnostics = await collectDiagnostics();
			const filesWithErrors: Array<{ file: string; count: number }> = [];
			let totalErrors = 0;

			for (const [file, diagnostics] of Object.entries(allDiagnostics)) {
				// Validate that the file path is within the workspace for security
				if (!isWithinCwd(file)) {
					continue;
				}

				// Treat undefined severity as error (severity 1) per LSP spec
				const errorCount = diagnostics.filter(
					(d) => d.severity === 1 || d.severity === undefined,
				).length;

				if (errorCount > 0) {
					filesWithErrors.push({ file, count: errorCount });
					totalErrors += errorCount;
				}
			}

			if (filesWithErrors.length === 0) {
				return null;
			}

			// Sort by error count
			filesWithErrors.sort((a, b) => b.count - a.count);

			// Get config for limits
			const config = getLspConfig();
			const maxFiles = config.maxFilesInContext ?? 5;

			// Take top files
			const topFiles = filesWithErrors.slice(0, maxFiles);
			const otherFilesCount = Math.max(0, filesWithErrors.length - maxFiles);

			let summary = `LSP Status: ${totalErrors} error${totalErrors === 1 ? "" : "s"} detected across ${filesWithErrors.length} file${filesWithErrors.length === 1 ? "" : "s"}.`;
			summary += "\nTop issues:";

			for (const { file, count } of topFiles) {
				// Sanitize file path to prevent Markdown injection
				const sanitizedFile = file.replace(/[`\n\r]/g, "");
				summary += `\n- ${sanitizedFile}: ${count} error${count === 1 ? "" : "s"}`;
			}

			if (otherFilesCount > 0) {
				summary += `\n...and ${otherFilesCount} more ${otherFilesCount === 1 ? "file" : "files"}.`;
			}

			return `# Workspace Health\n${summary}`;
		} catch (error) {
			logger.warn("Failed to load LSP context", {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			return null;
		}
	}
}

export class FrameworkPreferenceContextSource implements AgentContextSource {
	name = "framework-default";

	async getSystemPromptAdditions(): Promise<string | null> {
		const pref = resolveFrameworkPreference();
		if (!pref.id) return null;
		const info = getFrameworkSummary(pref.id);
		if (!info) return null;
		return `${info.summary} (source: ${pref.source})`;
	}
}

export class TeamMemoryContextSource implements AgentContextSource {
	name = "team-memory";

	constructor(private readonly cwd: string = process.cwd()) {}

	async getSystemPromptAdditions(): Promise<string | null> {
		try {
			return buildTeamMemoryPromptContext(this.cwd);
		} catch (error) {
			logger.warn("Failed to load team memory context", {
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}
}

/**
 * IDE context source that injects detected IDE information.
 * This helps the agent provide IDE-specific suggestions and commands.
 */
export class IDEContextSource implements AgentContextSource {
	name = "ide";

	async getSystemPromptAdditions(): Promise<string | null> {
		try {
			const ide = getPrimaryIDE();
			if (!ide) {
				return null;
			}

			const parts: string[] = [`IDE: ${ide.name}`];

			if (ide.version) {
				parts.push(`Version: ${ide.version}`);
			}

			if (ide.connectionMethod && ide.connectionMethod !== "none") {
				parts.push(`Integration: ${ide.connectionMethod}`);
			}

			// Add IDE-specific hints
			const hints = this.getIDEHints(ide);
			if (hints) {
				parts.push(`\n${hints}`);
			}

			return `# Development Environment\n${parts.join("\n")}`;
		} catch (error) {
			logger.warn("Failed to load IDE context", {
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	private getIDEHints(ide: IDEInfo): string | null {
		switch (ide.type) {
			case "vscode":
			case "vscode-insiders":
				return "User is in VS Code. Prefer VS Code keyboard shortcuts and extension suggestions.";
			case "cursor":
				return "User is in Cursor (AI-native VS Code fork). They have AI features built-in.";
			case "windsurf":
				return "User is in Windsurf. Suggest Windsurf-compatible workflows.";
			case "jetbrains-idea":
			case "jetbrains-webstorm":
			case "jetbrains-pycharm":
			case "jetbrains-goland":
			case "jetbrains-rider":
			case "jetbrains-clion":
			case "jetbrains-rubymine":
			case "jetbrains-datagrip":
				return "User is in a JetBrains IDE. Prefer JetBrains keyboard shortcuts and plugin suggestions.";
			case "vim":
			case "neovim":
				return "User is in Vim/Neovim. They likely prefer terminal-based workflows.";
			case "emacs":
				return "User is in Emacs. They likely prefer keyboard-driven workflows.";
			case "sublime":
				return "User is in Sublime Text. Suggest Sublime-compatible workflows.";
			case "zed":
				return "User is in Zed editor. They likely value performance and modern features.";
			default:
				return null;
		}
	}
}
