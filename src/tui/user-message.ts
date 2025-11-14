import {
	Container,
	Markdown,
	Spacer,
	Text,
	visibleWidth,
} from "../tui-lib/index.js";
import chalk from "chalk";

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	private markdown: Markdown;

	constructor(text: string, isFirst: boolean) {
		super();

		// Add spacer before user message (except first one)
		if (!isFirst) {
			this.addChild(new Spacer(1));
		}

		const panelWidth = this.computePanelWidth(text);
		const label = chalk.hex("#9ea3ff").bold("YOU");
		this.addChild(
			new Text(this.buildTopLine(panelWidth, label, "#4c1d95"), 1, 0),
		);
		const accent = chalk.hex("#63d9ff")("▍");
		this.addChild(new Text(`${accent} ${chalk.dim("message")}`, 1, 0));

		// User messages with dark gray background
		this.markdown = new Markdown(text, undefined, undefined, {
			r: 42,
			g: 44,
			b: 58,
		});
		this.addChild(this.markdown);
		this.addChild(
			new Text(this.buildBottomLine(panelWidth, "#4c1d95"), 1, 0),
		);
	}

	private computePanelWidth(text: string): number {
		const lines = text.split("\n");
		const maxLine = lines.reduce(
			(max, line) => Math.max(max, visibleWidth(line)),
			0,
		);
		return Math.min(60, Math.max(32, maxLine + 6));
	}

	private buildTopLine(width: number, label: string, color: string): string {
		const labelWidth = visibleWidth(label) + 2;
		const dashCount = Math.max(0, width - labelWidth);
		return chalk.hex(color)(`╭ ${label} ${"─".repeat(dashCount)}╮`);
	}

	private buildBottomLine(width: number, color: string): string {
		return chalk.hex(color)(`╰${"─".repeat(width - 2)}╯`);
	}
}
