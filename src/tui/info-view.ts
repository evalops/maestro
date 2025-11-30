import type { Container, SlashCommand, TUI } from "@evalops/tui";
import { Spacer, Text } from "@evalops/tui";
import chalk from "chalk";

interface InfoViewOptions {
	chatContainer: Container;
	ui: TUI;
	getSlashCommands: () => SlashCommand[];
	isInteractive: () => boolean;
	getRecentCommands: () => string[];
	getFavoriteCommands: () => Set<string>;
}

export class InfoView {
	constructor(private readonly options: InfoViewOptions) {}

	showHelp(): void {
		const interactive = this.options.isInteractive();
		const commands = this.options.getSlashCommands();
		const recent = new Set(this.options.getRecentCommands());
		const favorites = this.options.getFavoriteCommands();
		const grouped = this.groupCommands(commands);
		const sections = grouped.map(({ title, cmds }) => {
			const rendered = cmds.map((cmd) => {
				const shortAliases = (cmd.aliases ?? []).filter((a) => a.length <= 2);
				const aliasHint =
					shortAliases.length > 0
						? chalk.dim(` (${shortAliases.join(", ")})`)
						: "";
				const example = cmd.examples?.[0] ?? cmd.usage ?? undefined;
				const tags = cmd.tags?.length
					? chalk.dim(`[${cmd.tags.join(", ")}] `)
					: "";
				const interactiveNote =
					!interactive && cmd.tags?.includes("ui")
						? chalk.dim(" (requires TTY)")
						: "";
				const fav = favorites.has(cmd.name) ? chalk.yellow("★ ") : "";
				const rec = recent.has(cmd.name) ? chalk.cyan("↺ ") : "";
				const exampleLine = example ? `  ${chalk.dim(example)}` : "";
				return `${fav}${rec}${chalk.cyan(`/${cmd.name}`)}${aliasHint} - ${tags}${cmd.description ?? ""}${interactiveNote}${
					exampleLine ? `\n${exampleLine}` : ""
				}`;
			});
			return `${chalk.bold(title)}\n${rendered.join("\n")}`;
		});
		const legend = `${chalk.dim(
			"★ favorite  ·  ↺ recent  ·  Use Ctrl+K for palette, ? for examples",
		)}\n`;
		const body = `${legend}${sections.join("\n\n")}`;
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(body, 1, 0));
		this.options.ui.requestRender();
	}

	private groupCommands(
		commands: SlashCommand[],
	): Array<{ title: string; cmds: SlashCommand[] }> {
		const order = [
			"ui",
			"session",
			"git",
			"planning",
			"tools",
			"diagnostics",
			"usage",
			"safety",
			"config",
			"automation",
			"auth",
			"system",
			"other",
		];
		const buckets = new Map<string, SlashCommand[]>();
		for (const cmd of commands) {
			const tag = cmd.tags?.[0] ?? "other";
			const normalized = order.includes(tag) ? tag : "other";
			const arr = buckets.get(normalized) ?? [];
			arr.push(cmd);
			buckets.set(normalized, arr);
		}
		const sections: Array<{ title: string; cmds: SlashCommand[] }> = [];
		for (const key of order) {
			const cmds = buckets.get(key);
			if (!cmds || cmds.length === 0) continue;
			cmds.sort((a, b) => a.name.localeCompare(b.name));
			sections.push({
				title: this.titleForGroup(key),
				cmds,
			});
		}
		return sections;
	}

	private titleForGroup(tag: string): string {
		switch (tag) {
			case "ui":
				return "UI & Display";
			case "session":
				return "Sessions";
			case "git":
				return "Git";
			case "planning":
				return "Planning & Queue";
			case "tools":
				return "Tools & MCP";
			case "diagnostics":
				return "Diagnostics";
			case "usage":
				return "Usage & Cost";
			case "safety":
				return "Safety";
			case "config":
				return "Config";
			case "automation":
				return "Automation";
			case "auth":
				return "Auth";
			case "system":
				return "System";
			default:
				return "Other";
		}
	}
}
