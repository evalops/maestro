import { getLspConfig } from "../config/lsp-config.js";
import { collectDiagnostics, getClients } from "../lsp/index.js";
import { formatTaskFailures } from "../tools/background-tasks.js";
import {
	formatGoalSection,
	formatSummarySection,
	formatTodosSection,
	loadStore,
} from "../tools/todo.js";
import { isWithinCwd } from "../utils/path-validation.js";
import type { AgentContextSource } from "./context-manager.js";

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
			console.warn("Failed to load todo context:", error);
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
			console.warn("Failed to load background task context:", error);
			return null;
		}
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
			console.warn("Failed to load LSP context:", error);
			return null;
		}
	}
}
