import type { Component } from "@evalops/tui";
import { visibleWidth } from "@evalops/tui";
import { theme } from "../theme/theme.js";

export class InstructionPanelComponent implements Component {
	private shortcuts = [
		{ keys: "esc", desc: "interrupt" },
		{ keys: "ctrl+c", desc: "clear" },
		{ keys: "ctrl+c×2", desc: "exit" },
		{ keys: "ctrl+k", desc: "delete line" },
		{ keys: "shift+tab", desc: "thinking level" },
		{ keys: "ctrl+p", desc: "cycle models" },
		{ keys: "/ command", desc: "commands" },
		{ keys: "drop", desc: "attach files" },
	];

	constructor(private readonly version: string) {}

	render(width: number): string[] {
		const panelWidth = this.calculateWidth(width);
		const innerWidth = Math.max(1, panelWidth - 4);
		const top = theme.fg("borderAccent", `╭${"─".repeat(panelWidth - 2)}╮`);
		const title = this.centerText(
			`composer v${this.version} · EvalOps`,
			innerWidth,
		);
		const titleLine = `${theme.fg("borderAccent", "│ ")}${theme.bold(
			theme.fg("text", title),
		)}${theme.fg("borderAccent", " │")}`;
		const separator = theme.fg(
			"borderAccent",
			`├${"─".repeat(panelWidth - 2)}┤`,
		);
		const keyWidth = Math.min(16, Math.max(10, Math.floor(innerWidth * 0.4)));
		const descWidth = Math.max(8, innerWidth - keyWidth - 1);
		const rows = this.shortcuts.map(({ keys, desc }) => {
			const keyLabel = theme.bold(
				theme.fg("accent", this.padText(keys, keyWidth)),
			);
			const descLabel = theme.fg("muted", this.padText(desc, descWidth));
			return `${theme.fg("borderAccent", "│ ")}${keyLabel} ${descLabel}${theme.fg("borderAccent", " │")}`;
		});
		const bottom = theme.fg("borderAccent", `╰${"─".repeat(panelWidth - 2)}╯`);
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
