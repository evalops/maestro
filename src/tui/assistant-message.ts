import { Container, Markdown, Spacer, Text } from "@evalops/tui";
import chalk from "chalk";
import type { RenderableAssistantMessage } from "../conversation/render-model.js";
import { italic } from "../style/theme.js";
import { getMarkdownTheme } from "../theme/theme.js";

const ASSISTANT_BORDER = "#fcd5ce";
const ASSISTANT_LABEL = "#ffafcc";
const ASSISTANT_FILL = { r: 22, g: 24, b: 30 };

/**
 * Component that renders a complete assistant message in a pastel card.
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private panelWidth = 64;

	constructor(message?: RenderableAssistantMessage) {
		super();
		this.contentContainer = new Container();
		this.addChild(new Text(this.buildTopLine(), 1, 0));
		this.addChild(
			new Text(
				`${chalk.hex(ASSISTANT_LABEL).bold("COMPOSER")} ${chalk.dim("· response")}`,
				1,
				0,
			),
		);
		this.addChild(this.contentContainer);
		this.addChild(new Text(this.buildBottomLine(), 1, 0));

		if (message) {
			this.updateContent(message);
		}
	}

	private buildTopLine(): string {
		const dashCount = Math.max(0, this.panelWidth - 2);
		return chalk.hex(ASSISTANT_BORDER)(`╭${"─".repeat(dashCount)}╮`);
	}

	private buildBottomLine(): string {
		const dashCount = Math.max(0, this.panelWidth - 2);
		return chalk.hex(ASSISTANT_BORDER)(`╰${"─".repeat(dashCount)}╯`);
	}

	updateContent(message: RenderableAssistantMessage): void {
		this.contentContainer.clear();

		const hasPrimaryContent =
			message.textBlocks.length > 0 || message.thinkingBlocks.length > 0;
		if (hasPrimaryContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		for (const text of message.textBlocks) {
			this.contentContainer.addChild(
				new Markdown(
					text,
					undefined,
					undefined,
					ASSISTANT_FILL,
					1,
					0,
					getMarkdownTheme(),
				),
			);
		}

		for (const thinking of message.thinkingBlocks) {
			const thinkingText = italic(thinking);
			this.contentContainer.addChild(
				new Markdown(
					thinkingText,
					undefined,
					undefined,
					undefined,
					1,
					0,
					getMarkdownTheme(),
				),
			);
			this.contentContainer.addChild(new Spacer(1));
		}

		const hasToolCalls = message.toolCalls.length > 0;
		if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				this.contentContainer.addChild(new Text(chalk.red("Aborted"), 1, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(
					new Text(chalk.red(`Error: ${errorMsg}`), 1, 0),
				);
			}
		}
	}
}
