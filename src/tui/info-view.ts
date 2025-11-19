import type { Container, SlashCommand, TUI } from "@evalops/tui";
import { Spacer, Text } from "@evalops/tui";
import chalk from "chalk";

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
