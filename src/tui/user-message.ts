import { Container, Markdown, Spacer, Text, visibleWidth } from "@evalops/tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { themedBottomLine, themedTopLine } from "./utils/borders.js";
import { formatRelativeTime } from "./utils/footer-utils.js";
import { PANEL_WIDTHS } from "./utils/layout.js";

/**
 * Component that renders a user message styled as a rounded card.
 * Right-aligned for chat bubble effect.
 */
export class UserMessageComponent extends Container {
	private markdown: Markdown;

	constructor(text: string, isFirst: boolean, timestamp?: number) {
		super();

		if (!isFirst) {
			this.addChild(new Spacer(1));
		}

		const terminalWidth = process.stdout.columns ?? 80;
		const panelWidth = this.computePanelWidth(text);
		// Calculate right-align offset (terminal width - panel width - margin)
		const rightOffset = Math.max(0, terminalWidth - panelWidth - 2);

		this.addChild(new Text(this.buildTopLine(panelWidth), rightOffset, 0));

		// Metadata line with relative timestamp right-aligned
		const ts = timestamp ?? Date.now();
		const relativeTime = formatRelativeTime(ts);
		const header = `${theme.fg("muted", `${relativeTime} ·`)} ${theme.fg("accent", "YOU")}`;
		this.addChild(new Text(header, rightOffset, 0));

		this.markdown = new Markdown(
			text,
			undefined,
			undefined,
			undefined, // Let markdown handle its own background or inherit
			rightOffset,
			0,
			getMarkdownTheme(),
		);
		this.addChild(this.markdown);
		this.addChild(new Text(this.buildBottomLine(panelWidth), rightOffset, 0));
	}

	private static readonly MIN_WIDTH = PANEL_WIDTHS.userMessage.min;
	private static readonly MAX_WIDTH = PANEL_WIDTHS.userMessage.max;

	private computePanelWidth(text: string): number {
		const lines = text.split("\n");
		const maxLine = lines.reduce(
			(max, line) => Math.max(max, visibleWidth(line)),
			0,
		);
		return Math.min(
			UserMessageComponent.MAX_WIDTH,
			Math.max(UserMessageComponent.MIN_WIDTH, maxLine + 6),
		);
	}

	private buildTopLine(width: number): string {
		return themedTopLine(width, { color: "border" });
	}

	private buildBottomLine(width: number): string {
		return themedBottomLine(width, { color: "border" });
	}
}
