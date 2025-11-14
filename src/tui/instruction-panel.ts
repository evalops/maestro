import chalk from "chalk";
import type { Component } from "../tui-lib/index.js";
import { visibleWidth } from "../tui-lib/index.js";

export class InstructionPanelComponent implements Component {
	private shortcuts = [
		{ keys: "esc", desc: "interrupt" },
		{ keys: "ctrl+c", desc: "clear" },
		{ keys: "ctrl+c×2", desc: "exit" },
		{ keys: "ctrl+k", desc: "delete line" },
		{ keys: "/ command", desc: "commands" },
		{ keys: "drop", desc: "attach files" },
	];

	constructor(private readonly version: string) {}

	render(width: number): string[] {
		const panelWidth = this.calculateWidth(width);
		const innerWidth = Math.max(1, panelWidth - 4);
		const top = chalk.hex("#8b5cf6")(`╭${"─".repeat(panelWidth - 2)}╮`);
		const title = this.centerText(
			`composer v${this.version} · EvalOps`,
			innerWidth,
		);
		const titleLine = `${chalk.hex("#8b5cf6")("│ ")}${chalk
			.hex("#e2e8f0")
			.bold(title)}${chalk.hex("#8b5cf6")(" │")}`;
		const separator = chalk.hex("#8b5cf6")(`├${"─".repeat(panelWidth - 2)}┤`);
		const keyWidth = Math.min(16, Math.max(10, Math.floor(innerWidth * 0.4)));
		const descWidth = Math.max(8, innerWidth - keyWidth - 1);
		const rows = this.shortcuts.map(({ keys, desc }) => {
			const keyLabel = chalk.hex("#f1c0e8").bold(this.padText(keys, keyWidth));
			const descLabel = chalk.hex("#94a3b8")(this.padText(desc, descWidth));
			return `${chalk.hex("#8b5cf6")("│ ")}${keyLabel} ${descLabel}${chalk.hex("#8b5cf6")(" │")}`;
		});
		const bottom = chalk.hex("#8b5cf6")(`╰${"─".repeat(panelWidth - 2)}╯`);
		return [top, titleLine, separator, ...rows, bottom];
	}

	private calculateWidth(terminalWidth: number): number {
		const maxWidth = Math.max(36, Math.floor(terminalWidth * 0.75));
		return Math.max(32, Math.min(maxWidth, terminalWidth - 2));
	}

	private padText(text: string, width: number): string {
		const length = visibleWidth(text);
		if (length >= width) {
			return text;
		}
		return `${text}${" ".repeat(width - length)}`;
	}

	private centerText(text: string, width: number): string {
		const length = visibleWidth(text);
		if (length >= width) {
			return text;
		}
		const totalPad = width - length;
		const left = Math.floor(totalPad / 2);
		const right = totalPad - left;
		return `${" ".repeat(left)}${text}${" ".repeat(right)}`;
	}
}
