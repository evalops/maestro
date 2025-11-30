import type { Container, SlashCommand, TUI } from "@evalops/tui";
import { Spacer, Text } from "@evalops/tui";
import chalk from "chalk";

interface InfoViewOptions {
	chatContainer: Container;
	ui: TUI;
	getSlashCommands: () => SlashCommand[];
	isInteractive: () => boolean;
}

export class InfoView {
	constructor(private readonly options: InfoViewOptions) {}

	showHelp(): void {
		const interactive = this.options.isInteractive();
		const commands = this.options.getSlashCommands();
		const lines = commands.map((cmd) => {
			const shortAliases = (cmd.aliases ?? []).filter((a) => a.length <= 2);
			const aliasHint =
				shortAliases.length > 0
					? chalk.dim(` (${shortAliases.join(", ")})`)
					: "";
			const example =
				(cmd as any).examples?.[0] ?? (cmd as any).usage ?? undefined;
			const tags = cmd.tags?.length
				? chalk.dim(`[${cmd.tags.join(", ")}] `)
				: "";
			const interactiveNote =
				!interactive && cmd.tags?.includes("ui")
					? chalk.dim(" (requires TTY)")
					: "";
			return `${chalk.cyan(`/${cmd.name}`)}${aliasHint} - ${tags}${cmd.description}${interactiveNote}${
				example ? `\n  ${chalk.dim(example)}` : ""
			}`;
		});
		const body = `${chalk.bold("Slash commands")}
${lines.join("\n")}`;
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(body, 1, 0));
		this.options.ui.requestRender();
	}
}
