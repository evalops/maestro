import { type SelectItem, SelectList } from "@evalops/tui";
import { Container, Text } from "@evalops/tui";
import chalk from "chalk";

export class FileSearchComponent extends Container {
	private list: SelectList;
	private filterLabel: Text;
	private filter = "";

	constructor(
		files: string[],
		private onSelect: (file: string) => void,
		private onCancel: () => void,
	) {
		super();
		const items: SelectItem[] = files.map((file) => ({
			value: file,
			label: file,
		}));

		this.addChild(new Text(chalk.hex("#38bdf8")("─".repeat(60)), 0, 0));
		this.filterLabel = new Text(this.buildPrompt(), 1, 0);
		this.addChild(this.filterLabel);

		this.list = new SelectList(items, 8);
		this.list.onSelect = (item) => this.onSelect(item.value);
		this.list.onCancel = () => this.onCancel();
		this.addChild(this.list);
		this.addChild(new Text(chalk.hex("#38bdf8")("─".repeat(60)), 0, 0));
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
		this.filterLabel.setText(this.buildPrompt());
		this.list.setFilter(this.filter);
	}

	private buildPrompt(): string {
		const hint = this.filter
			? `@ ${this.filter}`
			: chalk.dim("Type to search files");
		return `${chalk.hex("#bae6fd")("File search")} ${hint}`;
	}
}
