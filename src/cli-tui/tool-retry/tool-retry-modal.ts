import type { Component } from "@evalops/tui";
import chalk from "chalk";
import type { ToolRetryRequest } from "../../agent/tool-retry.js";
import { type BorderStyle, getBorderChars } from "../utils/borders.js";
import {
	centerText,
	padLine,
	sanitizeAnsi,
	truncateText,
	wrapTextBlock,
} from "../utils/text-formatting.js";

interface ToolRetryModalOptions {
	request: ToolRetryRequest;
	queueSize: number;
	onRetry: () => void;
	onSkip: () => void;
	onAbort: () => void;
	onCancel: () => void;
}

export class ToolRetryModal implements Component {
	private queueSize: number;

	constructor(private readonly options: ToolRetryModalOptions) {
		this.queueSize = options.queueSize;
	}

	setQueueSize(size: number): void {
		this.queueSize = size;
	}

	private static readonly BORDER_COLOR = "#f87171";
	private static readonly BORDER_STYLE: BorderStyle = "double";

	render(width: number): string[] {
		const borderColor = ToolRetryModal.BORDER_COLOR;
		const chars = getBorderChars(ToolRetryModal.BORDER_STYLE);
		const innerWidth = Math.max(1, width - 4);
		const lines: string[] = [];
		const borderV = chalk.hex(borderColor)(chars.vertical);

		const pushRow = (content: string): void => {
			const safeContent = truncateText(content, innerWidth);
			const padded = padLine(safeContent, innerWidth);
			lines.push(`${borderV} ${padded} ${borderV}`);
		};
		const pushSpacer = (): void => {
			pushRow(" ".repeat(innerWidth));
		};
		const pushSection = (title: string, content: string[]): void => {
			pushRow(chalk.hex("#fecaca").bold(title));
			for (const line of content) {
				pushRow(line);
			}
		};

		const topLine = `${chars.topLeft}${chars.horizontal.repeat(Math.max(0, width - 2))}${chars.topRight}`;
		lines.push(chalk.hex(borderColor)(topLine));

		const title = centerText("TOOL RETRY", innerWidth);
		pushRow(chalk.hex("#fee2e2").bold(title));

		const sepLine = `${chars.leftT}${chars.horizontal.repeat(Math.max(0, width - 2))}${chars.rightT}`;
		lines.push(chalk.hex(borderColor)(sepLine));

		pushSection("Error", this.describeError(innerWidth));
		pushSpacer();
		pushSection("Tool", this.describeTool(innerWidth));
		pushSpacer();
		pushSection("Command", this.formatCommand(innerWidth));
		pushSpacer();
		pushSection("Queue Status", [this.describeQueue()]);

		lines.push(chalk.hex(borderColor)(sepLine));

		const footer = centerText(
			"[r] retry  [s] skip  [a] abort  [esc] cancel",
			innerWidth,
		);
		pushRow(chalk.dim(footer));

		const bottomLine = `${chars.bottomLeft}${chars.horizontal.repeat(Math.max(0, width - 2))}${chars.bottomRight}`;
		lines.push(chalk.hex(borderColor)(bottomLine));

		return lines;
	}

	handleInput(data: string): void {
		if (data === "r" || data === "R") {
			this.options.onRetry();
			return;
		}
		if (data === "s" || data === "S") {
			this.options.onSkip();
			return;
		}
		if (data === "a" || data === "A") {
			this.options.onAbort();
			return;
		}
		if (data === "\x1b") {
			this.options.onCancel();
		}
	}

	private describeError(width: number): string[] {
		const errorMessage =
			this.options.request.errorMessage.trim().length > 0
				? this.options.request.errorMessage
				: "(no error message)";
		return wrapTextBlock(errorMessage, width);
	}

	private describeTool(width: number): string[] {
		const entries: string[] = [];
		entries.push(
			`${chalk.hex("#fecdd3")("Name:")} ${chalk.hex("#fca5a5").bold(this.options.request.toolName)}`,
		);
		const attemptLabel = this.options.request.maxAttempts
			? `${this.options.request.attempt} / ${this.options.request.maxAttempts}`
			: `${this.options.request.attempt}`;
		entries.push(
			`${chalk.hex("#fecdd3")("Attempt:")} ${chalk.hex("#fee2e2")(attemptLabel)}`,
		);
		return wrapTextBlock(entries.join("\n"), width);
	}

	private extractCommand(): string[] | null {
		const args = this.options.request.args;
		const cmd =
			args &&
			typeof args === "object" &&
			"command" in args &&
			typeof (args as { command?: unknown }).command === "string"
				? (args as { command: string }).command
				: null;
		if (typeof cmd !== "string" || cmd.trim().length === 0) {
			return null;
		}
		const scrubbed = cmd.replace(/[^\x20-\x7e\r\n]/g, "");
		return scrubbed.trim().split(/\r?\n/).slice(0, 6);
	}

	private formatCommand(width: number): string[] {
		const command = this.extractCommand();
		if (!command) {
			return [chalk.dim("(no literal command provided)")];
		}
		const sanitized = command
			.map((line) => `  ${sanitizeAnsi(line)}`)
			.join("\n");
		return wrapTextBlock(sanitized, width);
	}

	private describeQueue(): string {
		if (this.queueSize > 0) {
			const noun = this.queueSize === 1 ? "request" : "requests";
			return chalk.dim(`${this.queueSize} more ${noun} awaiting retry`);
		}
		return chalk.dim("No other pending retry requests");
	}
}
