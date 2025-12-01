import { Editor } from "@evalops/tui";

/**
 * Custom editor that handles Escape and Ctrl+C keys for Composer
 */
export class CustomEditor extends Editor {
	public onEscape?: () => void;
	public onCtrlC?: () => void;
	public onShortcut?: (shortcut: string) => boolean;
	public onHistoryNavigate?: (direction: "prev" | "next") => boolean;
	public onShiftTab?: () => boolean | undefined;
	public onCtrlP?: () => void;
	public onCtrlO?: () => void;
	public onTyping?: () => void;
	public onTab?: () => boolean;

	handleInput(data: string): void {
		// Tab cycles slash hints when provided (unless autocomplete is open)
		if (data === "\t" && this.onTab && !this.isShowingAutocomplete()) {
			const handled = this.onTab();
			if (handled) return;
		}

		// Ctrl+P cycles models
		if (data === "\x10" && this.onCtrlP) {
			this.onCtrlP();
			return;
		}

		// Ctrl+O toggles tool output expansion
		if (data === "\x0f" && this.onCtrlO) {
			this.onCtrlO();
			return;
		}

		// Shift+Tab cycles thinking levels (or slash reverse cycle)
		if (data === "\x1b[Z" && this.onShiftTab) {
			const handled = this.onShiftTab();
			if (handled) return;
		}

		// Intercept Escape key - but only if autocomplete is NOT active
		// (let parent handle escape for autocomplete cancellation)
		if (data === "\x1b" && this.onEscape && !this.isShowingAutocomplete()) {
			this.onEscape();
			return;
		}

		// Ctrl+K opens palette
		if (data === "\x0b" && this.onShortcut) {
			const handled = this.onShortcut("ctrl+k");
			if (handled) {
				return;
			}
		}

		// @ triggers file search (only when not autocompleting)
		if (data === "@" && this.onShortcut) {
			const handled = this.onShortcut("at");
			if (handled) {
				return;
			}
		}

		// 'k' or 'K' can trigger keep-partial during interrupt (if handler returns true)
		if ((data === "k" || data === "K") && this.onShortcut) {
			const handled = this.onShortcut("k");
			if (handled) {
				return;
			}
		}

		// Intercept Ctrl+C
		if (data === "\x03" && this.onCtrlC) {
			this.onCtrlC();
			return;
		}

		if (data === "\x1b[A" && this.onHistoryNavigate) {
			const handled = this.onHistoryNavigate("prev");
			if (handled) {
				return;
			}
		}

		if (data === "\x1b[B" && this.onHistoryNavigate) {
			const handled = this.onHistoryNavigate("next");
			if (handled) {
				return;
			}
		}

		if (this.isPrintableInput(data) && this.onTyping) {
			this.onTyping();
		}

		// Pass to parent for normal handling
		super.handleInput(data);
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
