import type { Component } from "@evalops/tui";
import { visibleWidth } from "@evalops/tui";
import { theme } from "../theme/theme.js";
import {
	getTuiKeybindingLabel,
	getTuiKeybindingShortcut,
} from "./keybindings.js";
import { getQueuedFollowUpEditBindingLabel } from "./queue/queued-follow-up-edit-binding.js";

export class InstructionPanelComponent implements Component {
	constructor(private readonly version: string) {}

	render(width: number): string[] {
		const panelWidth = this.calculateWidth(width);
		const innerWidth = Math.max(1, panelWidth - 4);
		const top = theme.fg("borderAccent", `╭${"─".repeat(panelWidth - 2)}╮`);
		const title = this.centerText(
			`maestro v${this.version} · EvalOps`,
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
		const rows = this.buildShortcuts().map(({ keys, desc }) => {
			const keyLabel = theme.bold(
				theme.fg("accent", this.padText(keys, keyWidth)),
			);
			const descLabel = theme.fg("muted", this.padText(desc, descWidth));
			return `${theme.fg("borderAccent", "│ ")}${keyLabel} ${descLabel}${theme.fg("borderAccent", " │")}`;
		});
		const bottom = theme.fg("borderAccent", `╰${"─".repeat(panelWidth - 2)}╯`);
		return [top, titleLine, separator, ...rows, bottom];
	}

	private buildShortcuts(): Array<{ keys: string; desc: string }> {
		const commandPaletteBinding =
			getTuiKeybindingLabel("command-palette").toLowerCase();
		const shortcuts = [
			{ keys: "enter", desc: "send / steer" },
			{ keys: "tab", desc: "send / queue" },
			{
				keys: getQueuedFollowUpEditBindingLabel().toLowerCase(),
				desc: "edit queued follow-up",
			},
			{ keys: "esc", desc: "interrupt" },
			{ keys: "ctrl+c", desc: "clear" },
			{ keys: "ctrl+c×2", desc: "exit" },
			{
				keys: commandPaletteBinding,
				desc: "command palette",
			},
			{
				keys: getTuiKeybindingLabel("external-editor").toLowerCase(),
				desc: "external editor",
			},
			{ keys: "ctrl+v", desc: "paste image" },
			{
				keys: getTuiKeybindingLabel("suspend").toLowerCase(),
				desc: "suspend",
			},
			{ keys: "shift+tab", desc: "thinking level" },
			{
				keys: getTuiKeybindingLabel("cycle-model").toLowerCase(),
				desc: "cycle models",
			},
			{ keys: "/ command", desc: "commands" },
			{ keys: "drop", desc: "attach files" },
		];

		if (getTuiKeybindingShortcut("command-palette") !== "ctrl+k") {
			shortcuts.splice(6, 0, { keys: "ctrl+k", desc: "delete line" });
		}

		return shortcuts;
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
