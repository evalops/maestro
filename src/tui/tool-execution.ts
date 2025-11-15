import chalk from "chalk";
import { Container, Spacer, Text } from "../tui-lib/index.js";
import {
	type ToolRenderer,
	createToolRenderer,
} from "./tool-renderers/index.js";
import { shortenPath } from "./tool-text-utils.js";

/**
 * Component that renders a tool call with its result (updateable)
 */
export class ToolExecutionComponent extends Container {
	private contentText: Text;
	private toolName: string;
	private args: any;
	private collapsed = false;
	private result?: {
		content: Array<{
			type: string;
			text?: string;
			data?: string;
			mimeType?: string;
		}>;
		isError: boolean;
		details?: any;
	};

	private renderer: ToolRenderer;

	constructor(toolName: string, args: any) {
		super();
		this.toolName = toolName;
		this.args = args;
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.buildTopLine(), 1, 0));
		// Content with colored background and padding
		this.contentText = new Text("", 1, 1, { r: 34, g: 36, b: 48 });
		this.addChild(this.contentText);
		this.addChild(new Text(this.buildBottomLine(), 1, 0));
		this.renderer = createToolRenderer(this.toolName);
		this.updateDisplay();
	}

	setCollapsed(collapsed: boolean): void {
		this.collapsed = collapsed;
		this.updateDisplay();
	}

	private buildTopLine(): string {
		const label = this.toolName.toUpperCase();
		const accent = "#475569";
		const width = 50;
		const dashCount = Math.max(0, width - (label.length + 4));
		return chalk.hex(accent)(`╭ ${label} ${"─".repeat(dashCount)}╮`);
	}

	private buildBottomLine(): string {
		const accent = "#475569";
		const width = 50;
		return chalk.hex(accent)(`╰${"─".repeat(width - 2)}╯`);
	}

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	updateResult(result: {
		content: Array<{
			type: string;
			text?: string;
			data?: string;
			mimeType?: string;
		}>;
		details?: any;
		isError: boolean;
	}): void {
		this.result = result;
		this.updateDisplay();
	}

	private updateDisplay(): void {
		const bgColor = this.result
			? this.result.isError
				? { r: 68, g: 36, b: 44 }
				: { r: 36, g: 52, b: 42 }
			: { r: 34, g: 36, b: 48 };

		this.contentText.setCustomBgRgb(bgColor);
		this.contentText.setText(this.formatToolExecution());
	}

	private formatToolExecution(): string {
		const header = this.buildHeaderLine();
		const body = this.renderer.render({
			toolName: this.toolName,
			args: this.args,
			result: this.result,
			collapsed: this.collapsed,
		});
		const footer = this.buildFooterLine();
		return [header, body, footer]
			.filter((section) => section?.trim())
			.join("\n\n");
	}

	getToolName(): string {
		return this.toolName;
	}

	private buildHeaderLine(): string {
		const statusIcon = this.result
			? this.result.isError
				? chalk.hex("#f87171")("✖")
				: chalk.hex("#34d399")("✔")
			: chalk.hex("#facc15")("⏳");
		const label = chalk.bold(this.toolName.toUpperCase());
		const argsSummary = this.getArgsSummary();
		const collapsedHint = this.collapsed ? chalk.dim(" (collapsed)") : "";
		return `${statusIcon} ${label}${argsSummary ? chalk.dim(` · ${argsSummary}`) : ""}${collapsedHint}`;
	}

	private getArgsSummary(): string | null {
		if (!this.args || typeof this.args !== "object") {
			return null;
		}
		const pathLike = (this.args as any).file_path || (this.args as any).path;
		if (typeof pathLike === "string" && pathLike.trim()) {
			return this.truncateSummary(shortenPath(pathLike.trim()));
		}
		const command = (this.args as any).command;
		if (typeof command === "string" && command.trim()) {
			return this.truncateSummary(command.trim());
		}
		return null;
	}

	private truncateSummary(value: string, limit = 48): string {
		if (value.length <= limit) {
			return value;
		}
		return `${value.slice(0, limit - 1)}…`;
	}

	private buildFooterLine(): string {
		if (!this.result) {
			return "";
		}
		if (this.result.isError) {
			return chalk.hex("#fca5a5")("Tool failed");
		}
		if (!this.result.content || this.result.content.length === 0) {
			return chalk.dim("No tool output captured");
		}
		return "";
	}
}
