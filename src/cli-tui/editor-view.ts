import type { CommandEntry } from "./commands/types.js";
import type { CustomEditor } from "./custom-editor.js";

interface EditorViewOptions {
	editor: CustomEditor;
	getCommandEntries: () => CommandEntry[];
	onFirstInput: () => void;
	onCommandExecuted?: (name: string) => void;
	onSubmit: (text: string) => void;
	shouldInterrupt: () => boolean;
	onInterrupt?: () => void;
	/**
	 * Called when 'k' is pressed during interrupt-armed state to keep partial response.
	 * Should return true if the key was handled (interrupt was armed), false otherwise.
	 */
	onKeepPartial?: () => boolean;
	onCtrlC?: () => void;
	/**
	 * Called when Ctrl+D is pressed with an empty editor.
	 * Standard Unix behavior: exit/end of input.
	 */
	onCtrlD?: () => void;
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
		editor.onCtrlD = () => {
			this.options.onCtrlD?.();
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
			// 'k' during interrupt-armed state keeps partial response
			if (shortcut === "k" && this.options.onKeepPartial) {
				return this.options.onKeepPartial();
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
				this.options.onCommandExecuted?.(command.command.name);
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
