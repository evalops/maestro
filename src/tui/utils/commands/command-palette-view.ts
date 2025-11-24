import type { SlashCommand } from "@evalops/tui";
import type { Container, TUI } from "@evalops/tui";
import type { CustomEditor } from "../../custom-editor.js";
import type { ModalManager } from "../../modal-manager.js";
import { CommandPaletteComponent } from "./command-palette.js";

interface CommandPaletteViewOptions {
	editor: CustomEditor;
	modalManager: ModalManager;
	ui: TUI;
	getCommands: () => SlashCommand[];
}

export class CommandPaletteView {
	private commandPalette: CommandPaletteComponent | null = null;

	constructor(private readonly options: CommandPaletteViewOptions) {}

	showCommandPalette(): void {
		if (this.commandPalette) return;
		this.commandPalette = new CommandPaletteComponent(
			this.options.getCommands(),
			(command) => {
				this.hideCommandPalette();
				const current = this.options.editor.getText().trim();
				const insertion = `/${command.name} `;
				if (!current) {
					this.options.editor.setText(insertion);
				} else {
					this.options.editor.insertText(insertion);
				}
				this.options.ui.requestRender();
			},
			() => this.hideCommandPalette(),
		);
		this.options.modalManager.push(this.commandPalette);
	}

	hideCommandPalette(): void {
		if (!this.commandPalette) return;
		this.options.modalManager.pop();
		this.commandPalette = null;
	}
}
