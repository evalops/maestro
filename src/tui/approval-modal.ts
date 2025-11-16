import chalk from "chalk";
import type { ActionApprovalRequest } from "../agent/action-approval.js";
import { type Component, visibleWidth } from "../tui-lib/index.js";

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

	render(width: number): string[] {
		const lines: string[] = [];
		const header = chalk.hex("#fbbf24").bold("⚠ Approval required");
		lines.push(this.pad(header, width));
		lines.push("");
		lines.push(
			this.pad(
				`${chalk.bold("Reason")}: ${this.options.request.reason}`,
				width,
			),
		);
		lines.push(
			this.pad(
				`${chalk.bold("Tool")}: ${this.options.request.toolName}`,
				width,
			),
		);
		const command = this.extractCommand();
		if (command) {
			lines.push("");
			lines.push(this.pad(chalk.bold("Command"), width));
			lines.push(...command.map((line) => this.pad(`  ${line}`, width)));
		}
		lines.push("");
		const queueLine =
			this.queueSize > 0
				? chalk.dim(
						`${this.queueSize} more action${this.queueSize === 1 ? "" : "s"} pending`,
					)
				: chalk.dim("No other pending approvals");
		lines.push(this.pad(queueLine, width));
		lines.push(
			this.pad(
				chalk.hex("#cbd5f5")("[y] approve  [n] deny  [esc] cancel"),
				width,
			),
		);
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
		const cmd = this.options.request.args?.command;
		if (typeof cmd !== "string" || cmd.trim().length === 0) {
			return null;
		}
		return cmd.trim().split(/\r?\n/).slice(0, 6);
	}

	private pad(text: string, width: number): string {
		if (visibleWidth(text) >= width) {
			return text;
		}
		return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
	}
}
