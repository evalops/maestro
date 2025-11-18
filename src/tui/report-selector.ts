import chalk from "chalk";
import {
	type Component,
	Container,
	type SelectItem,
	SelectList,
} from "../tui-lib/index.js";

type ReportType = "bug" | "feedback";

class Divider implements Component {
	render(width: number): string[] {
		return [chalk.blue("─".repeat(Math.max(1, width)))];
	}
}

export class ReportSelectorComponent extends Container {
	private readonly selectList: SelectList;

	constructor(onSelect: (type: ReportType) => void, onCancel: () => void) {
		super();

		const options: SelectItem[] = [
			{
				value: "bug",
				label: "Bug report",
				description: "Full diagnostics, git status, and attachments",
			},
			{
				value: "feedback",
				label: "Feedback",
				description: "Lightweight template for product ideas",
			},
		];

		this.addChild(new Divider());
		this.selectList = new SelectList(options, options.length);
		this.selectList.onSelect = (item) => {
			onSelect(item.value as ReportType);
		};
		this.selectList.onCancel = () => {
			onCancel();
		};
		this.addChild(this.selectList);
		this.addChild(new Divider());
	}

	getSelectList(): SelectList {
		return this.selectList;
	}
}

export type { ReportType };
