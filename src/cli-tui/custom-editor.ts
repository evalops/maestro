import { Editor, KittyKeys, isCtrlD, isShiftTab } from "@evalops/tui";

type CustomEditorBinding = {
	description: string;
	matches: (data: string) => boolean;
	when?: (editor: CustomEditor) => boolean;
	handle: (editor: CustomEditor, data: string) => boolean;
};

const CUSTOM_EDITOR_KEYMAP: CustomEditorBinding[] = [
	{
		description:
			"Tab cycles slash hints when provided (unless autocomplete is open)",
		matches: (data) => data === "\t",
		when: (editor) => Boolean(editor.onTab) && !editor.isShowingAutocomplete(),
		handle: (editor) => editor.onTab?.() === true,
	},
	{
		description: "Ctrl+P cycles models",
		matches: (data) => data === "\x10",
		when: (editor) => Boolean(editor.onCtrlP),
		handle: (editor) => {
			editor.onCtrlP?.();
			return true;
		},
	},
	{
		description: "Ctrl+O toggles tool output expansion",
		matches: (data) => data === "\x0f",
		when: (editor) => Boolean(editor.onCtrlO),
		handle: (editor) => {
			editor.onCtrlO?.();
			return true;
		},
	},
	{
		description: "Ctrl+T toggles thinking block visibility",
		matches: (data) => data === "\x14",
		when: (editor) => Boolean(editor.onCtrlT),
		handle: (editor) => {
			editor.onCtrlT?.();
			return true;
		},
	},
	{
		description: "Ctrl+G opens external editor",
		matches: (data) => data === "\x07",
		when: (editor) => Boolean(editor.onCtrlG),
		handle: (editor) => {
			editor.onCtrlG?.();
			return true;
		},
	},
	{
		description: "Ctrl+Z suspends to background",
		matches: (data) => data === "\x1a",
		when: (editor) => Boolean(editor.onCtrlZ),
		handle: (editor) => {
			editor.onCtrlZ?.();
			return true;
		},
	},
	{
		description: "Shift+Tab cycles thinking levels (or slash reverse cycle)",
		matches: (data) => isShiftTab(data),
		when: (editor) => Boolean(editor.onShiftTab),
		handle: (editor) => editor.onShiftTab?.() === true,
	},
	{
		description: "Shift+Enter inserts newline (Kitty protocol)",
		matches: (data) => data === KittyKeys.SHIFT_ENTER,
		handle: (editor) => {
			editor.insertText("\n");
			return true;
		},
	},
	{
		description: "Alt+Enter inserts newline (Kitty protocol)",
		matches: (data) => data === KittyKeys.ALT_ENTER,
		handle: (editor) => {
			editor.insertText("\n");
			return true;
		},
	},
	{
		description: "Ctrl+V pastes an image from clipboard",
		matches: (data) => data === "\x16",
		when: (editor) => Boolean(editor.onPasteImage),
		handle: (editor) => {
			editor.onPasteImage?.();
			return true;
		},
	},
	{
		description: "Escape closes Composer modals (unless autocomplete is open)",
		matches: (data) => data === "\x1b",
		when: (editor) =>
			Boolean(editor.onEscape) && !editor.isShowingAutocomplete(),
		handle: (editor) => {
			editor.onEscape?.();
			return true;
		},
	},
	{
		description: "Ctrl+K opens command palette",
		matches: (data) => data === "\x0b",
		when: (editor) => Boolean(editor.onShortcut),
		handle: (editor) => editor.onShortcut?.("ctrl+k") === true,
	},
	{
		description: "@ triggers file search (only when not autocompleting)",
		matches: (data) => data === "@",
		when: (editor) => Boolean(editor.onShortcut),
		handle: (editor) => editor.onShortcut?.("at") === true,
	},
	{
		description:
			"'k' can trigger keep-partial during interrupt (if handler returns true)",
		matches: (data) => data === "k" || data === "K",
		when: (editor) => Boolean(editor.onShortcut),
		handle: (editor) => editor.onShortcut?.("k") === true,
	},
	{
		description: "Ctrl+C interrupts the current run",
		matches: (data) => data === "\x03",
		when: (editor) => Boolean(editor.onCtrlC),
		handle: (editor) => {
			editor.onCtrlC?.();
			return true;
		},
	},
	{
		description: "Up arrow navigates history (when autocomplete is hidden)",
		matches: (data) => data === "\x1b[A",
		when: (editor) =>
			Boolean(editor.onHistoryNavigate) && !editor.isShowingAutocomplete(),
		handle: (editor) => editor.onHistoryNavigate?.("prev") === true,
	},
	{
		description: "Down arrow navigates history (when autocomplete is hidden)",
		matches: (data) => data === "\x1b[B",
		when: (editor) =>
			Boolean(editor.onHistoryNavigate) && !editor.isShowingAutocomplete(),
		handle: (editor) => editor.onHistoryNavigate?.("next") === true,
	},
	{
		description: "Page Up scrolls chat history",
		matches: (data) => data === "\x1b[5~",
		when: (editor) => Boolean(editor.onShortcut),
		handle: (editor) => editor.onShortcut?.("pageup") === true,
	},
	{
		description: "Page Down scrolls chat history",
		matches: (data) => data === "\x1b[6~",
		when: (editor) => Boolean(editor.onShortcut),
		handle: (editor) => editor.onShortcut?.("pagedown") === true,
	},
	{
		description: "Ctrl+U scrolls chat history half a page up (vim-style)",
		matches: (data) => data === "\x15",
		when: (editor) => Boolean(editor.onShortcut),
		handle: (editor) => editor.onShortcut?.("ctrl+u") === true,
	},
	{
		description:
			"Ctrl+D exits when editor empty, otherwise scrolls half page down",
		matches: (data) => isCtrlD(data),
		when: (editor) => Boolean(editor.onShortcut) || Boolean(editor.onCtrlD),
		handle: (editor) => {
			// When editor is empty and onCtrlD is set, exit
			if (editor.isEditorEmpty() && editor.onCtrlD) {
				editor.onCtrlD();
				return true;
			}
			// Otherwise scroll (vim-style behavior)
			return editor.onShortcut?.("ctrl+d") === true;
		},
	},
	{
		description: "Ctrl+Home jumps to top of chat history",
		matches: (data) => data === "\x1b[1;5H",
		when: (editor) => Boolean(editor.onShortcut),
		handle: (editor) => editor.onShortcut?.("ctrl+home") === true,
	},
	{
		description: "Ctrl+End jumps to bottom of chat history",
		matches: (data) => data === "\x1b[1;5F",
		when: (editor) => Boolean(editor.onShortcut),
		handle: (editor) => editor.onShortcut?.("ctrl+end") === true,
	},
];

/**
 * Custom editor that handles Escape and Ctrl+C keys for Composer
 */
export class CustomEditor extends Editor {
	public onEscape?: () => void;
	public onCtrlC?: () => void;
	public onCtrlD?: () => void;
	public onShortcut?: (shortcut: string) => boolean;
	public onHistoryNavigate?: (direction: "prev" | "next") => boolean;
	public onShiftTab?: () => boolean | undefined;
	public onCtrlP?: () => void;
	public onCtrlO?: () => void;
	public onCtrlT?: () => void;
	public onCtrlG?: () => void;
	public onCtrlZ?: () => void;
	public onTyping?: () => void;
	public onTab?: () => boolean;
	public onPasteImage?: () => void;

	handleInput(rawData: string): void {
		const data = this.normalizeArrowInput(rawData);
		if (this.tryHandleKeyBindings(data)) return;

		if (this.isPrintableInput(data) && this.onTyping) {
			this.onTyping();
		}

		// Pass to parent for normal handling
		super.handleInput(data);
	}

	private tryHandleKeyBindings(data: string): boolean {
		for (const binding of CUSTOM_EDITOR_KEYMAP) {
			if (!binding.matches(data)) continue;
			if (binding.when && !binding.when(this)) continue;
			if (binding.handle(this, data)) return true;
		}
		return false;
	}

	private isPrintableInput(data: string): boolean {
		if (!data) {
			return false;
		}
		// Ignore escape/control sequences that begin with ESC
		if (data.startsWith("\x1b")) {
			return false;
		}
		for (const char of data) {
			const codePoint = char.codePointAt(0);
			if (codePoint === undefined) {
				continue;
			}
			if (codePoint >= 0x20 && codePoint !== 0x7f) {
				return true;
			}
		}
		return false;
	}
}
