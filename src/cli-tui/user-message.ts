import {
	type Component,
	Container,
	Markdown,
	Spacer,
	Text,
	visibleWidth,
} from "@evalops/tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { themedBottomLine, themedTopLine } from "./utils/borders.js";
import { formatRelativeTime } from "./utils/footer-utils.js";
import { PANEL_WIDTHS } from "./utils/layout.js";

/**
 * Simple wrapper component that adds left offset to a child component.
 * Used for right-aligning content within a container.
 */
class OffsetWrapper implements Component {
	constructor(
		private child: Component,
		private offsetX: number,
		private fixedWidth: number,
	) {}

	render(_width: number): string[] {
		// Render child at fixed width, then add left offset
		const childLines = this.child.render(this.fixedWidth);
		const leftPad = " ".repeat(this.offsetX);
		return childLines.map((line) => leftPad + line);
	}
}

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

		// Top border - use OffsetWrapper instead of paddingX (paddingX * 2 breaks width calculation)
		this.addChild(
			new OffsetWrapper(
				new Text(this.buildTopLine(panelWidth), 0, 0),
				rightOffset,
				panelWidth,
			),
		);

		// Metadata line with relative timestamp
		const ts = timestamp ?? Date.now();
		const relativeTime = formatRelativeTime(ts);
		const header = `${theme.fg("muted", `${relativeTime} ·`)} ${theme.fg("accent", "YOU")}`;
		this.addChild(
			new OffsetWrapper(new Text(header, 1, 0), rightOffset, panelWidth),
		);

		// Message content
		this.markdown = new Markdown(
			text,
			undefined,
			undefined,
			undefined,
			1, // Internal padding
			0,
			getMarkdownTheme(),
		);
		this.addChild(new OffsetWrapper(this.markdown, rightOffset, panelWidth));

		// Bottom border
		this.addChild(
			new OffsetWrapper(
				new Text(this.buildBottomLine(panelWidth), 0, 0),
				rightOffset,
				panelWidth,
			),
		);
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
