import type { Component } from "@evalops/tui";
import chalk from "chalk";
import type { ActionApprovalRequest } from "../../agent/action-approval.js";
import {
	type BorderStyle,
	getBorderChars,
	themedBottomLine,
	themedSeparatorLine,
	themedTopLine,
} from "../utils/borders.js";
import {
	centerText,
	padLine,
	sanitizeAnsi,
	truncateText,
	wrapTextBlock,
} from "../utils/text-formatting.js";

interface ApprovalModalOptions {
	request: ActionApprovalRequest;
	queueSize: number;
	onApprove: () => void;
	onDeny: () => void;
	onCancel: () => void;
}

export class ApprovalModal implements Component {
	private queueSize: number;

	constructor(private readonly options: ApprovalModalOptions) {
		this.queueSize = options.queueSize;
	}

	setQueueSize(size: number): void {
		this.queueSize = size;
	}

	private static readonly BORDER_COLOR = "#fbbf24";
	private static readonly BORDER_STYLE: BorderStyle = "double";

	render(width: number): string[] {
		const borderColor = ApprovalModal.BORDER_COLOR;
		const chars = getBorderChars(ApprovalModal.BORDER_STYLE);
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
			pushRow(chalk.hex("#cbd5f5").bold(title));
			for (const line of content) {
				pushRow(line);
			}
		};

		// Top border with title
		const topLine = `${chars.topLeft}${chars.horizontal.repeat(Math.max(0, width - 2))}${chars.topRight}`;
		lines.push(chalk.hex(borderColor)(topLine));

		const title = centerText("ACTION APPROVAL", innerWidth);
		pushRow(chalk.hex("#e2e8f0").bold(title));

		// Separator
		const sepLine = `${chars.leftT}${chars.horizontal.repeat(Math.max(0, width - 2))}${chars.rightT}`;
		lines.push(chalk.hex(borderColor)(sepLine));

		pushSection("Reason", this.describeReason(innerWidth));
		pushSpacer();
		pushSection("Tool", this.describeTool(innerWidth));
		pushSpacer();
		pushSection("Command", this.formatCommand(innerWidth));
		pushSpacer();
		pushSection("Queue Status", [this.describeQueue()]);

		// Footer separator
		lines.push(chalk.hex(borderColor)(sepLine));

		const footer = centerText(
			"[y] approve  [n] deny  [esc] cancel",
			innerWidth,
		);
		pushRow(chalk.dim(footer));

		// Bottom border
		const bottomLine = `${chars.bottomLeft}${chars.horizontal.repeat(Math.max(0, width - 2))}${chars.bottomRight}`;
		lines.push(chalk.hex(borderColor)(bottomLine));

		return lines;
	}

	handleInput(data: string): void {
		if (data === "y" || data === "Y") {
			this.options.onApprove();
			return;
		}
		if (data === "n" || data === "N") {
			this.options.onDeny();
			return;
		}
		if (data === "\x1b") {
			this.options.onCancel();
		}
	}

	private extractCommand(): string[] | null {
		const cmd =
			this.options.request.args &&
			typeof this.options.request.args === "object" &&
			"command" in this.options.request.args &&
			typeof (this.options.request.args as { command?: unknown }).command ===
				"string"
				? (this.options.request.args as { command: string }).command
				: null;
		if (typeof cmd !== "string" || cmd.trim().length === 0) {
			return null;
		}
		// Strip control characters (including ANSI escapes) to avoid terminal injection
		const scrubbed = cmd.replace(/[^\x20-\x7e\r\n]/g, "");
		return scrubbed.trim().split(/\r?\n/).slice(0, 6);
	}

	private describeReason(width: number): string[] {
		const reason =
			typeof this.options.request.reason === "string" &&
			this.options.request.reason.trim().length > 0
				? this.options.request.reason
				: chalk.dim("(no reason provided)");
		return wrapTextBlock(reason, width);
	}

	private describeTool(width: number): string[] {
		const entries: string[] = [];
		entries.push(
			`${chalk.hex("#94a3b8")("Name:")} ${chalk.hex("#60a5fa").bold(this.options.request.toolName)}`,
		);
		const action =
			this.options.request.args &&
			typeof this.options.request.args === "object" &&
			"action" in this.options.request.args
				? (this.options.request.args as { action?: unknown }).action
				: undefined;
		if (typeof action === "string") {
			entries.push(
				`${chalk.hex("#94a3b8")("Action:")} ${chalk.hex("#e2e8f0")(action)}`,
			);
		}
		const shell =
			this.options.request.args &&
			typeof this.options.request.args === "object" &&
			"shell" in this.options.request.args
				? (this.options.request.args as { shell?: unknown }).shell
				: undefined;
		if (typeof shell === "boolean") {
			entries.push(
				`${chalk.hex("#94a3b8")("Shell mode:")} ${shell ? chalk.hex("#fbbf24")("enabled") : chalk.hex("#10b981")("disabled")}`,
			);
		}
		return wrapTextBlock(entries.join("\n"), width);
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
			const noun = this.queueSize === 1 ? "action" : "actions";
			return chalk.dim(`${this.queueSize} more ${noun} awaiting approval`);
		}
		return chalk.dim("No other pending approvals");
	}
}
