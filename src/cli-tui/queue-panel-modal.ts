import type { Component } from "@evalops/tui";
import chalk from "chalk";
import type { QueuedPrompt } from "./prompt-queue.js";
import {
	centerText,
	padLine,
	sanitizeAnsi,
	truncateText,
} from "./utils/text-formatting.js";

interface QueuePanelModalOptions {
	onClose: () => void;
	onCancel: (id: number) => void;
	onToggleMode: () => void;
}

export class QueuePanelModal implements Component {
	private activePrompt: QueuedPrompt | null = null;
	private pendingPrompts: QueuedPrompt[] = [];
	private selectedIndex = 0;
	private mode: "one" | "all" = "all";

	constructor(private readonly options: QueuePanelModalOptions) {}

	setData(
		active: QueuedPrompt | null,
		pending: QueuedPrompt[],
		mode: "one" | "all",
	): void {
		this.activePrompt = active;
		this.pendingPrompts = pending;
		this.mode = mode;
		// Clamp selected index
		if (this.selectedIndex >= pending.length) {
			this.selectedIndex = Math.max(0, pending.length - 1);
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const borderColor = "#8b5cf6";

		// Top border
		lines.push(chalk.hex(borderColor)(`╭${"─".repeat(width - 2)}╮`));

		// Title
		const title = centerText("PROMPT QUEUE", width - 4);
		lines.push(
			`${chalk.hex(borderColor)("│ ")}${chalk.hex("#e2e8f0").bold(title)}${chalk.hex(borderColor)(" │")}`,
		);

		// Separator
		lines.push(chalk.hex(borderColor)(`├${"─".repeat(width - 2)}┤`));

		// Mode
		const modeLabel =
			this.mode === "all"
				? "Mode: all (submissions enqueue while running)"
				: "Mode: one-at-a-time (submissions paused while running)";
		const modeLine = padLine(chalk.hex("#94a3b8")(modeLabel), width - 4);
		lines.push(
			`${chalk.hex(borderColor)("│ ")}${modeLine}${chalk.hex(borderColor)(" │")}`,
		);

		lines.push(
			`${chalk.hex(borderColor)("│ ")}${" ".repeat(width - 4)}${chalk.hex(borderColor)(" │")}`,
		);

		// Active prompt
		if (this.activePrompt) {
			const activeLabel = padLine(
				chalk.green(`Active: #${this.activePrompt.id}`),
				width - 4,
			);
			lines.push(
				`${chalk.hex(borderColor)("│ ")}${activeLabel}${chalk.hex(borderColor)(" │")}`,
			);
			const activeText = this.formatText(this.activePrompt.text, width - 6);
			const activeLine = padLine(
				chalk.hex("#94a3b8")(`  ${activeText}`),
				width - 4,
			);
			lines.push(
				`${chalk.hex(borderColor)("│ ")}${activeLine}${chalk.hex(borderColor)(" │")}`,
			);
			lines.push(
				`${chalk.hex(borderColor)("│ ")}${" ".repeat(width - 4)}${chalk.hex(borderColor)(" │")}`,
			);
		}

		// Pending prompts
		if (this.pendingPrompts.length === 0) {
			const emptyLine = padLine(chalk.dim("No queued prompts."), width - 4);
			lines.push(
				`${chalk.hex(borderColor)("│ ")}${emptyLine}${chalk.hex(borderColor)(" │")}`,
			);
		} else {
			const pendingLabel = padLine(
				chalk.hex("#f1c0e8")("Pending prompts:"),
				width - 4,
			);
			lines.push(
				`${chalk.hex(borderColor)("│ ")}${pendingLabel}${chalk.hex(borderColor)(" │")}`,
			);

			const maxDisplay = 8;
			const start = Math.max(
				0,
				Math.min(
					this.selectedIndex - Math.floor(maxDisplay / 2),
					this.pendingPrompts.length - maxDisplay,
				),
			);
			const visible = this.pendingPrompts.slice(start, start + maxDisplay);

			for (let i = 0; i < visible.length; i++) {
				const prompt = visible[i];
				const actualIndex = start + i;
				const isSelected = actualIndex === this.selectedIndex;
				const prefix = isSelected ? chalk.cyan("► ") : "  ";
				const label = `#${prompt.id}`;
				const text = this.formatText(prompt.text, width - 12);
				const promptLine = padLine(
					`${prefix}${chalk.hex("#60a5fa")(label)} ${chalk.hex("#94a3b8")(text)}`,
					width - 4,
				);
				lines.push(
					`${chalk.hex(borderColor)("│ ")}${promptLine}${chalk.hex(borderColor)(" │")}`,
				);
			}

			if (this.pendingPrompts.length > maxDisplay) {
				const remainingCount = this.pendingPrompts.length - maxDisplay;
				const moreLabel = padLine(
					chalk.dim(`... and ${remainingCount} more`),
					width - 4,
				);
				lines.push(
					`${chalk.hex(borderColor)("│ ")}${moreLabel}${chalk.hex(borderColor)(" │")}`,
				);
			}
		}

		// Bottom separator
		lines.push(chalk.hex(borderColor)(`├${"─".repeat(width - 2)}┤`));

		// Help text
		const helpText = "[↑/↓] navigate  [x] cancel  [m] toggle mode  [esc] close";
		const helpLine = centerText(helpText, width - 4);
		lines.push(
			`${chalk.hex(borderColor)("│ ")}${chalk.dim(helpLine)}${chalk.hex(borderColor)(" │")}`,
		);

		// Bottom border
		lines.push(chalk.hex(borderColor)(`╰${"─".repeat(width - 2)}╯`));

		return lines;
	}

	handleInput(data: string): void {
		if (data === "\x1b") {
			// Escape
			this.options.onClose();
			return;
		}
		if (data === "\x1b[A") {
			// Up arrow
			if (this.pendingPrompts.length > 0) {
				this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			}
			return;
		}
		if (data === "\x1b[B") {
			// Down arrow
			if (this.pendingPrompts.length > 0) {
				this.selectedIndex = Math.min(
					this.pendingPrompts.length - 1,
					this.selectedIndex + 1,
				);
			}
			return;
		}
		if (data === "x" || data === "X") {
			// Cancel selected prompt
			const selected = this.pendingPrompts[this.selectedIndex];
			if (selected) {
				this.options.onCancel(selected.id);
			}
			return;
		}
		if (data === "m" || data === "M") {
			// Toggle mode
			this.options.onToggleMode();
			return;
		}
	}

	private formatText(text: string, maxLength: number): string {
		const singleLine = sanitizeAnsi(text).replace(/\s+/g, " ").trim();
		if (!singleLine) {
			return "(empty message)";
		}
		return truncateText(singleLine, maxLength);
	}
}
