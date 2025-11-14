import chalk from "chalk";
import {
	Container,
	Markdown,
	Spacer,
	Text,
	visibleWidth,
} from "../tui-lib/index.js";

const USER_BORDER = "#6e7fff";
const USER_LABEL = "#c7d2fe";
const USER_FILL = { r: 26, g: 28, b: 38 };

/**
 * Component that renders a user message styled as a rounded card.
 */
export class UserMessageComponent extends Container {
	private markdown: Markdown;

	constructor(text: string, isFirst: boolean) {
		super();

		if (!isFirst) {
			this.addChild(new Spacer(1));
		}

		const panelWidth = this.computePanelWidth(text);
		this.addChild(new Text(this.buildTopLine(panelWidth), 1, 0));
		this.addChild(
			new Text(
				`${chalk.hex(USER_LABEL).bold("YOU")} ${chalk.dim("· message")}`,
				1,
				0,
			),
		);

		this.markdown = new Markdown(text, undefined, undefined, USER_FILL, 1, 0);
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
		return chalk.hex(USER_BORDER)(`╭${"─".repeat(dash)}╮`);
	}

	private buildBottomLine(width: number): string {
		const dash = width - 2;
		return chalk.hex(USER_BORDER)(`╰${"─".repeat(dash)}╯`);
	}
}
