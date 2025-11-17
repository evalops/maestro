import chalk from "chalk";
import type { Container, SlashCommand, TUI } from "../tui-lib/index.js";
import { Spacer, Text } from "../tui-lib/index.js";

interface InfoViewOptions {
	chatContainer: Container;
	ui: TUI;
	getSlashCommands: () => SlashCommand[];
}

export class InfoView {
	constructor(private readonly options: InfoViewOptions) {}

	showHelp(): void {
		const lines = this.options
			.getSlashCommands()
			.map((cmd) => `${chalk.cyan(`/${cmd.name}`)} - ${cmd.description}`);
		const body = `${chalk.bold("Slash commands")}
${lines.join("\n")}`;
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(body, 1, 0));
		this.options.ui.requestRender();
	}
}
