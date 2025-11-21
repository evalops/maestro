import { Container, Spacer, Text } from "@evalops/tui";
import chalk from "chalk";
import {
	type ToolRenderer,
	createToolRenderer,
} from "./tool-renderers/index.js";

/**
 * Component that renders a tool call with its result (updateable)
 */
export class ToolExecutionComponent extends Container {
	private contentText: Text;
	private toolName: string;
	private args: Record<string, unknown>;
	private partialArgs: Record<string, unknown>;
	private collapsed = false;
	private pendingStatus: string | null = null;
	private result?: {
		content: Array<{
			type: string;
			text?: string;
			data?: string;
			mimeType?: string;
		}>;
		isError: boolean;
		details?: unknown;
	};

	private renderer: ToolRenderer;

	constructor(toolName: string, args: Record<string, unknown>) {
		super();
		this.toolName = toolName;
		this.args = args;
		this.partialArgs = args;
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

	updateArgs(args: Record<string, unknown>): void {
		this.args = args;
		this.partialArgs = args;
		this.updateDisplay();
	}

	updatePartialArgs(args: Record<string, unknown>): void {
		this.partialArgs = args;
		this.updateDisplay();
	}

	updateResult(result: {
		content: Array<{
			type: string;
			text?: string;
			data?: string;
			mimeType?: string;
		}>;
		details?: unknown;
		isError: boolean;
	}): void {
		this.result = result;
		this.updateDisplay();
	}

	setPendingStatus(status: string | null): void {
		this.pendingStatus = status;
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
		const body = this.renderer.render({
			toolName: this.toolName,
			args: this.args,
			partialArgs: this.partialArgs,
			result: this.result,
			collapsed: this.collapsed,
		});
		if (!this.pendingStatus) {
			return body;
		}
		const banner = chalk.hex("#fbbf24")(
			`⚠ ${this.pendingStatus.trim() || "Awaiting approval"}`,
		);
		return `${banner}\n\n${body}`;
	}

	getToolName(): string {
		return this.toolName;
	}
}
