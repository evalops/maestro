/**
 * HistoryController — Handles /history and /toolhistory commands.
 *
 * Renders prompt history, tool execution history, and tool statistics.
 * Stateless — all data comes from the SessionContext stores.
 */

import type { CommandExecutionContext } from "../commands/types.js";
import type { PromptHistoryEntry } from "../history/prompt-history.js";
import type {
	ToolHistoryEntry,
	ToolHistoryStore,
} from "../history/tool-history.js";
import type { SessionContext } from "../session/session-context.js";
import { formatDuration, formatPreview } from "../utils/text-preview.js";

// ─── Callback & Dependency Interfaces ────────────────────────────────────────

export interface HistoryControllerCallbacks {
	/** Push markdown/text content into the chat container. */
	pushCommandOutput: (text: string) => void;
	/** Show a transient info notification. */
	showInfo: (message: string) => void;
}

export interface HistoryControllerDeps {
	/** Session context that owns the history stores. */
	sessionContext: SessionContext;
}

export interface HistoryControllerOptions {
	deps: HistoryControllerDeps;
	callbacks: HistoryControllerCallbacks;
}

// ─── Controller ──────────────────────────────────────────────────────────────

export class HistoryController {
	private readonly deps: HistoryControllerDeps;
	private readonly callbacks: HistoryControllerCallbacks;

	constructor(options: HistoryControllerOptions) {
		this.deps = options.deps;
		this.callbacks = options.callbacks;
	}

	// ─── /history ──────────────────────────────────────────────────────────

	handleHistoryCommand(context: CommandExecutionContext): void {
		const raw = context.argumentText.trim();
		const history = this.deps.sessionContext.getPromptHistory();
		if (["help", "?", "-h", "--help"].includes(raw.toLowerCase())) {
			context.renderHelp();
			return;
		}

		if (!raw) {
			this.renderPromptHistory(history.recent(20), "Recent Prompts");
			return;
		}

		if (raw.toLowerCase() === "clear") {
			history.clear();
			context.showInfo("Prompt history cleared.");
			return;
		}

		if (/^\d+$/.test(raw)) {
			const count = Number.parseInt(raw, 10);
			this.renderPromptHistory(history.recent(count), "Recent Prompts");
			return;
		}

		const results = history.search(raw, 10);
		if (results.length === 0) {
			context.showInfo(`No matches for "${raw}".`);
			return;
		}
		this.renderPromptHistory(results, `Search Results for "${raw}"`);
	}

	// ─── /toolhistory ──────────────────────────────────────────────────────

	handleToolHistoryCommand(context: CommandExecutionContext): void {
		const raw = context.argumentText.trim();
		const toolHistory = this.deps.sessionContext.getToolHistory();
		if (["help", "?", "-h", "--help"].includes(raw.toLowerCase())) {
			context.renderHelp();
			return;
		}

		const parts = raw.split(/\s+/).filter(Boolean);
		const primary = parts[0]?.toLowerCase();

		if (!primary) {
			this.renderToolHistoryList(
				toolHistory.recent(10),
				"Recent Tool Executions",
			);
			return;
		}

		if (primary === "clear") {
			toolHistory.clear();
			context.showInfo("Tool history cleared.");
			return;
		}

		if (primary === "stats" || primary === "statistics") {
			this.renderToolHistoryStats(toolHistory);
			return;
		}

		if (primary === "tool") {
			const name = parts.slice(1).join(" ").trim();
			if (!name) {
				context.showError("Usage: /toolhistory tool <name>");
				return;
			}
			this.renderToolHistoryForTool(toolHistory, name);
			return;
		}

		if (/^\d+$/.test(primary)) {
			const count = Number.parseInt(primary, 10);
			this.renderToolHistoryList(
				toolHistory.recent(count),
				"Recent Tool Executions",
			);
			return;
		}

		this.renderToolHistoryForTool(toolHistory, primary);
	}

	// ─── Rendering ─────────────────────────────────────────────────────────

	private renderPromptHistory(
		entries: PromptHistoryEntry[],
		title: string,
	): void {
		if (!entries.length) {
			this.callbacks.showInfo("No prompt history.");
			return;
		}
		const lines = [`## ${title}`, ""];
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			if (!entry) continue;
			lines.push(`${i + 1}. ${formatPreview(entry.prompt, 80)}`);
		}
		this.callbacks.pushCommandOutput(lines.join("\n"));
	}

	private renderToolHistoryList(
		entries: ToolHistoryEntry[],
		title: string,
	): void {
		if (!entries.length) {
			this.callbacks.showInfo("No tool history.");
			return;
		}
		const lines = [`## ${title}`, ""];
		for (const entry of entries) {
			const status = entry.isError ? "✗" : "✓";
			lines.push(
				`${status} ${entry.tool} (${formatDuration(entry.durationMs)})`,
			);
		}
		this.callbacks.pushCommandOutput(lines.join("\n"));
	}

	private renderToolHistoryStats(toolHistory: ToolHistoryStore): void {
		const stats = toolHistory.stats();
		if (stats.total === 0) {
			this.callbacks.showInfo("No tool history.");
			return;
		}
		const entries = Array.from(stats.byTool.entries()).sort(
			(a, b) => b[1].total - a[1].total,
		);
		const lines = [
			"## Tool Statistics",
			"",
			`Total executions: ${stats.total}`,
			"",
		];
		for (const [tool, summary] of entries) {
			const errorRate =
				summary.total > 0
					? `${Math.round((summary.errors / summary.total) * 100)}%`
					: "0%";
			lines.push(
				`${tool}: ${summary.total} run${summary.total === 1 ? "" : "s"} (${summary.errors} error${summary.errors === 1 ? "" : "s"}, ${errorRate} error rate)`,
			);
		}
		this.callbacks.pushCommandOutput(lines.join("\n"));
	}

	private renderToolHistoryForTool(
		toolHistory: ToolHistoryStore,
		name: string,
	): void {
		const entries = toolHistory.forTool(name, 10);
		if (!entries.length) {
			this.callbacks.showInfo(`No history for tool "${name}".`);
			return;
		}
		const lines = [`## History for "${name}"`, ""];
		for (const entry of entries) {
			const status = entry.isError ? "✗" : "✓";
			const preview = entry.preview
				? formatPreview(entry.preview, 80)
				: "(no output)";
			lines.push(`${status} ${formatDuration(entry.durationMs)} - ${preview}`);
		}
		this.callbacks.pushCommandOutput(lines.join("\n"));
	}
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createHistoryController(
	options: HistoryControllerOptions,
): HistoryController {
	return new HistoryController(options);
}
