import chalk from "chalk";
import type { SlashCommand, Container, TUI } from "../tui-lib/index.js";
import { Spacer, Text } from "../tui-lib/index.js";

interface InfoViewOptions {
	chatContainer: Container;
	ui: TUI;
	getSlashCommands: () => SlashCommand[];
	getLastUserMessage: () => string | undefined;
	getLastAssistantMessage: () => string | undefined;
	getLastRunToolNames: () => string[];
}

export class InfoView {
	constructor(private readonly options: InfoViewOptions) {}

	showHelp(): void {
		const lines = this.options
			.getSlashCommands()
			.map(
				(cmd) => `${chalk.cyan(`/${cmd.name}`)} - ${cmd.description}`,
			);
		const body = `${chalk.bold("Slash commands")}
${lines.join("\n")}`;
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(body, 1, 0));
		this.options.ui.requestRender();
	}

	showWhySummary(): void {
		const lastQuestion =
			this.options.getLastUserMessage() ??
			chalk.dim("No recent user question recorded.");
		const lastAnswer =
			this.options.getLastAssistantMessage() ??
			chalk.dim("No assistant response yet.");
		const tools = this.options.getLastRunToolNames();
		const toolLine = tools.length ? tools.join(", ") : chalk.dim("none");

		const text = `${chalk.bold("Why summary")}
${chalk.dim("Last question")}:
${lastQuestion}

${chalk.dim("Tools invoked")}:
${toolLine}

${chalk.dim("Assistant reply")}:
${lastAnswer}`;
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(text, 1, 0));
		this.options.ui.requestRender();
	}
}
