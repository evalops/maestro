import type { AssistantMessage } from "../agent/types.js";
import { Container, Markdown, Spacer, Text } from "../tui-lib/index.js";
import chalk from "chalk";

const ASSISTANT_BORDER = "#fcd5ce";
const ASSISTANT_LABEL = "#ffafcc";
const ASSISTANT_FILL = { r: 22, g: 24, b: 30 };

/**
 * Component that renders a complete assistant message in a pastel card.
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private panelWidth = 64;

	constructor(message?: AssistantMessage) {
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

	updateContent(message: AssistantMessage): void {
		this.contentContainer.clear();

		if (
			message.content.length > 0 &&
			message.content.some(
				(c) =>
					(c.type === "text" && c.text.trim()) ||
					(c.type === "thinking" && c.thinking.trim()),
			)
		) {
			this.contentContainer.addChild(new Spacer(1));
		}

		for (const content of message.content) {
			if (content.type === "text" && content.text.trim()) {
				this.contentContainer.addChild(
					new Markdown(
						content.text.trim(),
						undefined,
						undefined,
						ASSISTANT_FILL,
						1,
						0,
					),
				);
			} else if (content.type === "thinking" && content.thinking.trim()) {
				const thinkingText = chalk.gray.italic(content.thinking);
				this.contentContainer.addChild(
					new Markdown(thinkingText, undefined, undefined, undefined, 1, 0),
				);
				this.contentContainer.addChild(new Spacer(1));
			}
		}

		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				this.contentContainer.addChild(
					new Text(chalk.red("Aborted"), 1, 0),
				);
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(
					new Text(chalk.red(`Error: ${errorMsg}`), 1, 0),
				);
			}
		}
	}
}
