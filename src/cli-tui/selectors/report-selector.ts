import type { Component, SelectItem } from "@evalops/tui";
import chalk from "chalk";
import { BaseSelectorComponent } from "./base-selector.js";

type ReportType = "bug" | "feedback";

class Divider implements Component {
	render(width: number): string[] {
		return [chalk.blue("─".repeat(Math.max(1, width)))];
	}
}

export class ReportSelectorComponent extends BaseSelectorComponent<ReportType> {
	constructor(onSelect: (type: ReportType) => void, onCancel: () => void) {
		const options: Array<SelectItem & { value: ReportType }> = [
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

		super({
			items: options,
			onSelect,
			onCancel,
			topBorder: new Divider(),
			bottomBorder: new Divider(),
		});
	}
}

export type { ReportType };
