import { Container, Markdown, Spacer, Text, visibleWidth } from "@evalops/tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";

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
		const timeStr = ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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

	private computePanelWidth(text: string): number {
		const lines = text.split("\n");
		const maxLine = lines.reduce(
			(max, line) => Math.max(max, visibleWidth(line)),
			0,
		);
		return Math.min(72, Math.max(36, maxLine + 6));
	}

	private buildTopLine(width: number): string {
		const dash = width - 2;
		return theme.fg("border", `╭${"─".repeat(dash)}╮`);
	}

	private buildBottomLine(width: number): string {
		const dash = width - 2;
		return theme.fg("border", `╰${"─".repeat(dash)}╯`);
	}
}
