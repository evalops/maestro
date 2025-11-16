import type { CommandEntry } from "./commands/types.js";
import type { CustomEditor } from "./custom-editor.js";

interface EditorViewOptions {
	editor: CustomEditor;
	getCommandEntries: () => CommandEntry[];
	onFirstInput: () => void;
	onSubmit: (text: string) => void;
	shouldInterrupt: () => boolean;
	onInterrupt?: () => void;
	onCtrlC?: () => void;
	showCommandPalette: () => void;
	showFileSearch: () => void;
}

export class EditorView {
	constructor(private readonly options: EditorViewOptions) {
		const editor = options.editor;
		editor.onEscape = () => {
			if (this.options.shouldInterrupt() && this.options.onInterrupt) {
				this.options.onInterrupt();
			}
		};
		editor.onCtrlC = () => {
			this.options.onCtrlC?.();
		};
		editor.onShortcut = (shortcut) => {
			if (shortcut === "ctrl+k") {
				this.options.showCommandPalette();
				return true;
			}
			if (shortcut === "at") {
				this.options.showFileSearch();
				return true;
			}
			return false;
		};
		editor.onSubmit = (text) => {
			const trimmed = text.trim();
			if (!trimmed) {
				return;
			}
			this.options.onFirstInput();
			const command = this.options
				.getCommandEntries()
				.find((entry) => entry.matches(trimmed));
			if (command) {
				const outcome = command.execute(trimmed);
				this.options.editor.setText("");
				if (outcome && typeof (outcome as Promise<void>).then === "function") {
					void outcome;
				}
				return;
			}
			this.options.onSubmit(trimmed);
		};
	}
}
