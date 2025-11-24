import type { Component } from "@evalops/tui";
import { theme } from "../theme/theme.js";
import type { AgentState, AssistantMessage, ToolResultMessage } from "../agent/types.js";
import { calculateFooterStats, formatTokenCount } from "./utils/footer-utils.js";
import { centerText, padLine, truncateText } from "./utils/text-formatting.js";

interface ContextViewOptions {
	onClose: () => void;
	state: AgentState;
}

interface ContextItem {
	label: string;
	tokens: number;
	percent: number;
	type: "system" | "user" | "assistant" | "tool" | "file";
}

export class ContextView implements Component {
	private scrollOffset = 0;

	constructor(private readonly options: ContextViewOptions) {}

	render(width: number): string[] {
		const lines: string[] = [];

		// Top border
		lines.push(theme.fg("borderAccent", `╭${"─".repeat(width - 2)}╮`));

		// Title
		const title = centerText("CONTEXT USAGE", width - 4);
		lines.push(
			`${theme.fg("borderAccent", "│ ")}${theme.bold(theme.fg("text", title))}${theme.fg("borderAccent", " │")}`,
		);

		// Separator
		lines.push(theme.fg("borderAccent", `├${"─".repeat(width - 2)}┤`));

		const stats = calculateFooterStats(this.options.state);
		const items = this.analyzeContext(this.options.state, stats.contextTokens);

		// Stats Summary
		const summary = `Total: ${formatTokenCount(stats.contextTokens)} / ${formatTokenCount(stats.contextWindow)} (${stats.contextPercent.toFixed(1)}%)`;
		lines.push(
			`${theme.fg("borderAccent", "│ ")}${padLine(theme.fg("accent", summary), width - 4)}${theme.fg("borderAccent", " │")}`,
		);
		lines.push(
			`${theme.fg("borderAccent", "│ ")}${" ".repeat(width - 4)}${theme.fg("borderAccent", " │")}`,
		);

		// Render Items
		const maxDisplay = 15;
		const visibleItems = items.slice(this.scrollOffset, this.scrollOffset + maxDisplay);

		for (const item of visibleItems) {
			const typeIcon = this.getTypeIcon(item.type);
			const label = truncateText(item.label, width - 24);
			const tokens = formatTokenCount(item.tokens).padStart(6);
			const percent = `${item.percent.toFixed(1)}%`.padStart(6);

			const line = `${typeIcon} ${theme.fg("text", label.padEnd(width - 24))} ${theme.fg("dim", tokens)} ${theme.fg("dim", percent)}`;
			lines.push(
				`${theme.fg("borderAccent", "│ ")}${line}${theme.fg("borderAccent", " │")}`,
			);
		}

		// Fill remaining space if few items
		if (visibleItems.length < maxDisplay) {
			for (let i = 0; i < maxDisplay - visibleItems.length; i++) {
				lines.push(
					`${theme.fg("borderAccent", "│ ")}${" ".repeat(width - 4)}${theme.fg("borderAccent", " │")}`,
				);
			}
		}

		if (items.length > maxDisplay) {
			const moreText = `... ${items.length - maxDisplay} more (use arrows to scroll)`;
			lines.push(
				`${theme.fg("borderAccent", "│ ")}${padLine(theme.fg("dim", moreText), width - 4)}${theme.fg("borderAccent", " │")}`,
			);
		}

		// Bottom separator
		lines.push(theme.fg("borderAccent", `├${"─".repeat(width - 2)}┤`));

		const helpText = "[esc] close  [↑/↓] scroll";
		lines.push(
			`${theme.fg("borderAccent", "│ ")}${centerText(theme.fg("dim", helpText), width - 4)}${theme.fg("borderAccent", " │")}`,
		);

		// Bottom border
		lines.push(theme.fg("borderAccent", `╰${"─".repeat(width - 2)}╯`));

		return lines;
	}

	handleInput(data: string): void {
		if (data === "\x1b") {
			this.options.onClose();
			return;
		}
		if (data === "\x1b[A") { // Up
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			return;
		}
		if (data === "\x1b[B") { // Down
			this.scrollOffset = Math.max(0, this.scrollOffset + 1);
			return;
		}
	}

	private analyzeContext(state: AgentState, totalTokens: number): ContextItem[] {
		const items: ContextItem[] = [];
		// Estimate tokens: roughly chars / 4
		const estimate = (text: string) => Math.ceil(text.length / 4);

		// System Prompt
		if (state.systemPrompt) {
			const tokens = estimate(state.systemPrompt);
			items.push({
				label: "System Prompt",
				tokens,
				percent: totalTokens > 0 ? (tokens / totalTokens) * 100 : 0,
				type: "system",
			});
		}

		for (const msg of state.messages) {
			const tokens = estimate(JSON.stringify(msg.content));

			if (msg.role === "user") {
				let label = "";
				if (Array.isArray(msg.content)) {
					label = "Multipart User Message";
				} else {
					label = (msg.content as string).slice(0, 50).replace(/\n/g, " ");
				}

				items.push({
					label,
					tokens,
					percent: totalTokens > 0 ? (tokens / totalTokens) * 100 : 0,
					type: "user",
				});
			} else if (msg.role === "assistant") {
				const assistantMsg = msg as AssistantMessage;
				// Use actual usage if available
				const actualTokens = assistantMsg.usage
					? assistantMsg.usage.output ?? 0
					: tokens;
				items.push({
					label: "Assistant Response",
					tokens: actualTokens,
					percent: totalTokens > 0 ? (actualTokens / totalTokens) * 100 : 0,
					type: "assistant",
				});
			} else if (msg.role === "toolResult") {
				// Tool result
				items.push({
					label: `Tool Output (${(msg as ToolResultMessage).toolName})`,
					tokens,
					percent: totalTokens > 0 ? (tokens / totalTokens) * 100 : 0,
					type: "tool",
				});
			}
		}

		return items.sort((a, b) => b.tokens - a.tokens);
	}

	private getTypeIcon(type: ContextItem["type"]): string {
		switch (type) {
			case "system": return "⚙";
			case "user": return "👤";
			case "assistant": return "🤖";
			case "tool": return "🛠";
			case "file": return "📄";
		}
	}
}
