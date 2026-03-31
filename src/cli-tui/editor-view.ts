import type { CommandEntry } from "./commands/types.js";
import type { CustomEditor } from "./custom-editor.js";

interface EditorViewOptions {
	editor: CustomEditor;
	getCommandEntries: () => CommandEntry[];
	onFirstInput: () => void;
	onCommandExecuted?: (name: string) => void;
	onSubmit: (text: string) => void;
	canSubmitEmpty?: () => boolean;
	onFollowUp?: (text: string) => void;
	shouldFollowUp?: () => boolean;
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
	onEditLastQueuedFollowUp?: () => boolean;
}

export class EditorView {
	constructor(private readonly options: EditorViewOptions) {
		const editor = options.editor;
		const handleSubmit = (
			text: string,
			submit: (value: string) => void,
		): boolean => {
			const trimmed = text.trim();
			if (!trimmed) {
				if (this.options.canSubmitEmpty?.()) {
					submit("");
					return true;
				}
				return false;
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
				return true;
			}
			submit(trimmed);
			return true;
		};
		const previousOnTab = editor.onTab;
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
			if (shortcut === "edit-last-follow-up") {
				return this.options.onEditLastQueuedFollowUp?.() === true;
			}
			// 'k' during interrupt-armed state keeps partial response
			if (shortcut === "k" && this.options.onKeepPartial) {
				return this.options.onKeepPartial();
			}
			return false;
		};
		editor.onSubmit = (text) => {
			handleSubmit(text, this.options.onSubmit);
		};
		editor.onTab = () => {
			if (previousOnTab?.() === true) {
				return true;
			}
			if (!this.options.shouldFollowUp?.() || !this.options.onFollowUp) {
				return false;
			}
			const text = this.options.editor.getText();
			if (text.trimStart().startsWith("/")) {
				return false;
			}
			return handleSubmit(text, this.options.onFollowUp);
		};
		editor.onFollowUp = () => {
			if (this.options.shouldFollowUp && !this.options.shouldFollowUp()) {
				this.options.editor.insertText("\n");
				return;
			}
			if (this.options.onFollowUp) {
				handleSubmit(this.options.editor.getText(), this.options.onFollowUp);
			}
		};
	}
}
