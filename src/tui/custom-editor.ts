import { Editor } from "../tui-lib/index.js";

/**
 * Custom editor that handles Escape and Ctrl+C keys for Composer
 */
export class CustomEditor extends Editor {
	public onEscape?: () => void;
	public onCtrlC?: () => void;
	public onShortcut?: (shortcut: string) => boolean;
	public onHistoryNavigate?: (direction: "prev" | "next") => boolean;

	handleInput(data: string): void {
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

		// Pass to parent for normal handling
		super.handleInput(data);
	}
}
