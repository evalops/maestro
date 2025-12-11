import { Container, Spacer, Text } from "@evalops/tui";
import { type ThemeColor, theme } from "../theme/theme.js";
import {
	type ToolRenderer,
	createToolRenderer,
} from "./tool-renderers/index.js";
import {
	buildTopLineWithBadge,
	getBorderChars,
	themedBottomLine,
} from "./utils/borders.js";
import { PANEL_WIDTHS, responsiveWidth } from "./utils/layout.js";

/** Tool execution status for visual display */
type ToolStatus = "running" | "done" | "error" | "waiting";

/** Tool icon glyphs - Claude Code style (geometric, purposeful) */
const TOOL_ICONS: Record<string, string> = {
	bash: "⬢",
	edit: "✎",
	read: "◉",
	write: "◎",
	task: "◆",
	glob: "◇",
	grep: "⊙",
	webfetch: "⊕",
	websearch: "⊛",
	notebookedit: "▣",
	todowrite: "☑",
	default: "●",
};

/** Fallback ASCII icons for low-unicode terminals */
const TOOL_ICONS_ASCII: Record<string, string> = {
	bash: "$",
	edit: "~",
	read: ">",
	write: "+",
	task: "?",
	glob: "@",
	grep: "#",
	webfetch: "^",
	websearch: "*",
	notebookedit: "#",
	todowrite: "x",
	default: "*",
};

/** Status badge config - Claude Code style (minimal, semantic) */
const STATUS_CONFIG: Record<
	ToolStatus,
	{ label: string; glyph: string; color: ThemeColor }
> = {
	running: { label: "running", glyph: "◐", color: "warning" },
	done: { label: "done", glyph: "●", color: "success" },
	error: { label: "error", glyph: "✕", color: "error" },
	waiting: { label: "waiting", glyph: "◑", color: "warning" },
};

/** Duration for border flash effect in ms */
const FLASH_DURATION_MS = 400;

/** Skeleton shimmer animation frames */
const SKELETON_FRAMES = ["░", "▒", "▓", "▒"];
const SKELETON_INTERVAL_MS = 150;

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
	private defaultCollapsed = false;
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

	/** Border flash state: null = no flash, "success" | "error" = flashing */
	private flashState: "success" | "error" | null = null;
	private flashTimeout: NodeJS.Timeout | null = null;

	/** Skeleton shimmer animation state */
	private skeletonFrame = 0;
	private skeletonTimer: NodeJS.Timeout | null = null;

	constructor(toolName: string, args: Record<string, unknown>) {
		super();
		this.toolName = toolName;
		this.args = args;
		this.partialArgs = args;
		this.defaultCollapsed = false;
		this.collapsed = this.defaultCollapsed;
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
		this.startSkeletonAnimation();
	}

	private startSkeletonAnimation(): void {
		if (this.skeletonTimer) return;
		this.skeletonTimer = setInterval(() => {
			if (!this.result) {
				this.skeletonFrame = (this.skeletonFrame + 1) % SKELETON_FRAMES.length;
				this.updateDisplay();
			}
		}, SKELETON_INTERVAL_MS);
	}

	private stopSkeletonAnimation(): void {
		if (this.skeletonTimer) {
			clearInterval(this.skeletonTimer);
			this.skeletonTimer = null;
		}
	}

	private buildSkeletonLine(width: number): string {
		const frame = SKELETON_FRAMES[this.skeletonFrame] ?? "░";
		return theme.fg("dim", frame.repeat(Math.min(width, 30)));
	}

	setCollapsed(collapsed: boolean): void {
		this.collapsed = collapsed;
		this.updateDisplay();
	}

	private static readonly PANEL_WIDTH = PANEL_WIDTHS.tool;

	private getToolIcon(): string {
		return TOOL_ICONS[this.toolName.toLowerCase()] ?? TOOL_ICONS.default;
	}

	private getStatus(): ToolStatus {
		if (this.pendingStatus) {
			return "waiting";
		}
		if (!this.result) {
			return "running";
		}
		return this.result.isError ? "error" : "done";
	}

	private getBorderColor(): ThemeColor {
		if (this.flashState === "success") return "success";
		if (this.flashState === "error") return "error";
		return "borderMuted";
	}

	private buildTopLine(): string {
		const icon = this.getToolIcon();
		const label = `${icon} ${this.toolName.toLowerCase()}`;
		const status = this.getStatus();
		const {
			label: statusLabel,
			glyph,
			color: badgeColor,
		} = STATUS_CONFIG[status];
		const badge = `${glyph} ${statusLabel}`;

		return buildTopLineWithBadge(this.panelWidth(), {
			style: "square",
			title: label,
			badge,
			badgeColor,
			borderColor: this.getBorderColor(),
		});
	}

	private buildBottomLine(): string {
		const chars = getBorderChars("square");
		const innerWidth = Math.max(0, this.panelWidth() - 2);
		return theme.fg(
			this.getBorderColor(),
			`${chars.bottomLeft}${chars.horizontal.repeat(innerWidth)}${chars.bottomRight}`,
		);
	}

	private triggerFlash(type: "success" | "error"): void {
		// Clear any existing flash timeout
		if (this.flashTimeout) {
			clearTimeout(this.flashTimeout);
		}
		this.flashState = type;
		this.updateDisplay();

		// Reset flash after duration
		this.flashTimeout = setTimeout(() => {
			this.flashState = null;
			this.flashTimeout = null;
			this.updateDisplay();
		}, FLASH_DURATION_MS);
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
		const wasRunning = !this.result;
		this.result = result;

		// Stop skeleton animation once we have a result
		this.stopSkeletonAnimation();

		// Trigger border flash on completion
		if (wasRunning) {
			this.triggerFlash(result.isError ? "error" : "success");
		} else {
			this.updateDisplay();
		}
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
		// Show skeleton shimmer while waiting for result
		if (!this.result && !this.pendingStatus) {
			const skeleton = this.buildSkeletonLine(this.panelWidth() - 4);
			return `${skeleton}\n${skeleton}`;
		}

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
			`(!) ${this.pendingStatus.trim() || "Awaiting approval"}`,
		);
		return `${banner}\n\n${body}`;
	}

	getToolName(): string {
		return this.toolName;
	}

	prefersCollapsedByDefault(): boolean {
		return this.defaultCollapsed;
	}
}
