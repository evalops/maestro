import chalk from "chalk";
import type { SlashCommand } from "../tui-lib/autocomplete.js";
import {
	type SelectItem,
	SelectList,
} from "../tui-lib/components/select-list.js";
import { Container, Text } from "../tui-lib/index.js";

export class CommandPaletteComponent extends Container {
	private list: SelectList;
	private filterText: Text;
	private filter = "";
	private items: SelectItem[];
	private commandMap = new Map<string, SlashCommand>();

	constructor(
		commands: SlashCommand[],
		onSelect: (command: SlashCommand) => void,
		onCancel: () => void,
	) {
		super();

		for (const cmd of commands) {
			this.commandMap.set(cmd.name, cmd);
		}

		this.items = commands.map((cmd) => ({
			value: cmd.name,
			label: `/${cmd.name}`,
			description: cmd.description ?? "",
		}));

		this.addChild(new Text(chalk.hex("#7c3aed")("─".repeat(60)), 0, 0));
		this.filterText = new Text(this.buildPrompt(), 1, 0);
		this.addChild(this.filterText);

		this.list = new SelectList(this.items, 8);
		this.list.onSelect = (item) => {
			const command = this.commandMap.get(item.value);
			if (command) {
				onSelect(command);
			}
		};
		this.list.onCancel = onCancel;
		this.addChild(this.list);
		this.addChild(new Text(chalk.hex("#7c3aed")("─".repeat(60)), 0, 0));
	}

	handleInput(keyData: string): void {
		if (keyData === "\x7f" || keyData === "\x08") {
			if (this.filter.length > 0) {
				this.filter = this.filter.slice(0, -1);
				this.updateFilter();
			}
			return;
		}

		if (
			keyData.length === 1 &&
			keyData >= " " &&
			keyData <= "~" &&
			keyData !== "\r"
		) {
			this.filter += keyData;
			this.updateFilter();
			return;
		}

		this.list.handleInput(keyData);
	}

	private updateFilter(): void {
		this.filterText.setText(this.buildPrompt());
		this.list.setFilter(this.filter);
	}

	private buildPrompt(): string {
		const hint = this.filter
			? `/${this.filter}`
			: chalk.dim("Type to search commands");
		return `${chalk.hex("#a5b4fc")("Command palette")} ${hint}`;
	}
}
