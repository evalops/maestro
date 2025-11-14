import type { SlashCommand } from "../tui-lib/index.js";
import type { Container, TUI } from "../tui-lib/index.js";
import { CommandPaletteComponent } from "./command-palette.js";
import type { CustomEditor } from "./custom-editor.js";

interface CommandPaletteViewOptions {
	editor: CustomEditor;
	editorContainer: Container;
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
		this.options.editorContainer.clear();
		this.options.editorContainer.addChild(this.commandPalette);
		this.options.ui.setFocus(this.commandPalette);
		this.options.ui.requestRender();
	}

	hideCommandPalette(): void {
		if (!this.commandPalette) return;
		this.options.editorContainer.clear();
		this.options.editorContainer.addChild(this.options.editor);
		this.commandPalette = null;
		this.options.ui.setFocus(this.options.editor);
		this.options.ui.requestRender();
	}
}
