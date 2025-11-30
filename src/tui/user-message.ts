import { Container, Markdown, Spacer, Text, visibleWidth } from "@evalops/tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { themedBottomLine, themedTopLine } from "./utils/borders.js";
import { PANEL_WIDTHS } from "./utils/layout.js";

/**
 * Component that renders a user message styled as a rounded card.
 */
export class UserMessageComponent extends Container {
	private markdown: Markdown;

	constructor(text: string, isFirst: boolean, timestamp?: number) {
		super();

		if (!isFirst) {
			this.addChild(new Spacer(1));
		}

		const panelWidth = this.computePanelWidth(text);
		this.addChild(new Text(this.buildTopLine(panelWidth), 1, 0));

		// Metadata line
		const ts = timestamp ? new Date(timestamp) : new Date();
		const timeStr = ts.toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
		});
		const header = `${theme.fg("accent", "YOU")} ${theme.fg("muted", `· ${timeStr}`)}`;
		this.addChild(new Text(header, 1, 0));

		this.markdown = new Markdown(
			text,
			undefined,
			undefined,
			undefined, // Let markdown handle its own background or inherit
			1,
			0,
			getMarkdownTheme(),
		);
		this.addChild(this.markdown);
		this.addChild(new Text(this.buildBottomLine(panelWidth), 1, 0));
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
