import { Container, Spacer, Text } from "@evalops/tui";
import { theme } from "../theme/theme.js";
import {
	type ToolRenderer,
	createToolRenderer,
} from "./tool-renderers/index.js";
import { themedBottomLine, themedTopLine } from "./utils/borders.js";
import { PANEL_WIDTHS, responsiveWidth } from "./utils/layout.js";

/**
 * Component that renders a tool call with its result (updateable)
 */
export class ToolExecutionComponent extends Container {
	private contentText: Text;
	private topLine: Text;
	private bottomLine: Text;
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
		this.topLine = new Text(this.buildTopLine(), 1, 0);
		this.addChild(this.topLine);
		// Content
		this.contentText = new Text("", 1, 1);
		this.addChild(this.contentText);
		this.bottomLine = new Text(this.buildBottomLine(), 1, 0);
		this.addChild(this.bottomLine);
		this.renderer = createToolRenderer(this.toolName);
		this.updateDisplay();
	}

	setCollapsed(collapsed: boolean): void {
		this.collapsed = collapsed;
		this.updateDisplay();
	}

	private static readonly PANEL_WIDTH = PANEL_WIDTHS.tool;

	private buildTopLine(): string {
		const label = this.toolName.toUpperCase();
		return themedTopLine(this.panelWidth(), {
			title: theme.bold(label),
			color: "borderMuted",
		});
	}

	private buildBottomLine(): string {
		return themedBottomLine(this.panelWidth(), {
			color: "borderMuted",
		});
	}

	private panelWidth(): number {
		const cols = process.stdout.columns ?? 80;
		// Keep things readable on narrow terminals but expand when space allows.
		return responsiveWidth(cols, 48, 100, 0.72);
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
		// Refresh borders so they adapt to current terminal width.
		this.topLine.setText(this.buildTopLine());
		this.bottomLine.setText(this.buildBottomLine());
		// We rely on ANSI colors in the text itself rather than background fill
		// for a cleaner look
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
		const banner = theme.fg(
			"warning",
			`⚠ ${this.pendingStatus.trim() || "Awaiting approval"}`,
		);
		return `${banner}\n\n${body}`;
	}

	getToolName(): string {
		return this.toolName;
	}
}
