import { Container, Spacer, Text, visibleWidth } from "@evalops/tui";
import chalk from "chalk";
import { getBorderChars } from "./utils/borders.js";
import { PANEL_WIDTHS } from "./utils/layout.js";
import { isReducedMotionEnabled } from "./utils/motion.js";

export type ShellBlockStatus = "pending" | "success" | "error";

const BORDER_COLOR = "#475569";
const LABEL_COLOR = "#7dd3fc";
const PATH_COLOR = "#cbd5f5";
const ELAPSED_COLOR = "#94a3b8";
const BG_COLORS: Record<ShellBlockStatus, { r: number; g: number; b: number }> =
	{
		pending: { r: 14, g: 18, b: 28 },
		success: { r: 13, g: 24, b: 20 },
		error: { r: 32, g: 12, b: 18 },
	};

/**
 * Visually styled block that mimics a shell prompt/output panel.
 * Supports streaming output with real-time updates.
 */
export class BashShellBlock extends Container {
	private readonly panelWidth: number;
	private readonly title: string;
	private content: Text;
	private streamBuffer = "";
	private promptLine = "";
	private startTime: number;
	private elapsedText: Text | null = null;
	private bottomLine: Text;

	constructor(title: string, initialBody: string) {
		super();
		this.title = title;
		this.startTime = Date.now();
		this.panelWidth = Math.min(
			PANEL_WIDTHS.shellBlock.max,
			Math.max(PANEL_WIDTHS.shellBlock.min, visibleWidth(title) + 28),
		);
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.buildTopLine(), 1, 0));
		this.content = new Text(initialBody, 1, 1, BG_COLORS.pending);
		this.addChild(this.content);
		this.bottomLine = new Text(this.buildBottomLine(), 1, 0);
		this.addChild(this.bottomLine);
	}

	setBody(text: string): void {
		this.content.setText(text);
	}

	setStatus(status: ShellBlockStatus): void {
		this.content.setCustomBgRgb(BG_COLORS[status]);
	}

	/**
	 * Set the command prompt line (displayed at top of output).
	 */
	setPromptLine(prompt: string): void {
		this.promptLine = prompt;
	}

	/**
	 * Append streaming output to the buffer and update display.
	 */
	appendStreamOutput(chunk: string): void {
		this.streamBuffer += chunk;
		this.updateStreamingDisplay();
	}

	/**
	 * Update the display during streaming.
	 */
	private updateStreamingDisplay(): void {
		const elapsed = this.formatElapsed();
		const spinner = this.getSpinnerFrame();
		const lines = this.streamBuffer.split("\n");
		const maxLines = 20;
		const displayLines =
			lines.length > maxLines ? lines.slice(-maxLines) : lines;
		const truncationNote =
			lines.length > maxLines
				? chalk.hex(ELAPSED_COLOR)(
						`... (${lines.length - maxLines} lines hidden)\n`,
					)
				: "";

		const output =
			displayLines.join("\n") ||
			chalk.hex(ELAPSED_COLOR)("(waiting for output...)");
		const statusLine = chalk.hex(ELAPSED_COLOR)(
			`${spinner} Running... ${elapsed}`,
		);

		this.content.setText(
			`${this.promptLine}\n${truncationNote}${output}\n\n${statusLine}`,
		);
	}

	/**
	 * Get a spinner frame based on elapsed time.
	 */
	private getSpinnerFrame(): string {
		if (isReducedMotionEnabled()) {
			return chalk.hex(LABEL_COLOR)("•");
		}
		const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
		const elapsed = Date.now() - this.startTime;
		const idx = Math.floor(elapsed / 80) % frames.length;
		return chalk.hex(LABEL_COLOR)(frames[idx]);
	}

	/**
	 * Format elapsed time as human-readable string.
	 */
	private formatElapsed(): string {
		const elapsed = Date.now() - this.startTime;
		if (elapsed < 1000) {
			return `${elapsed}ms`;
		}
		const seconds = (elapsed / 1000).toFixed(1);
		return `${seconds}s`;
	}

	/**
	 * Get the elapsed time in milliseconds.
	 */
	getElapsedMs(): number {
		return Date.now() - this.startTime;
	}

	/**
	 * Clear the stream buffer (call before setting final body).
	 */
	clearStreamBuffer(): void {
		this.streamBuffer = "";
	}

	private buildTopLine(): string {
		const chars = getBorderChars("rounded");
		const label = chalk.hex(LABEL_COLOR).bold("bash");
		const meta = chalk.hex(PATH_COLOR)(this.title);
		const header = `${label} ${meta}`;
		const decorativeWidth = Math.max(
			0,
			this.panelWidth - visibleWidth(header) - 4,
		);
		return chalk.hex(BORDER_COLOR)(
			`${chars.topLeft} ${header} ${chars.horizontal.repeat(decorativeWidth)}${chars.topRight}`,
		);
	}

	private buildBottomLine(): string {
		const chars = getBorderChars("rounded");
		return chalk.hex(BORDER_COLOR)(
			`${chars.bottomLeft}${chars.horizontal.repeat(this.panelWidth - 2)}${chars.bottomRight}`,
		);
	}
}
