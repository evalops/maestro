import { describe, expect, it, vi } from "vitest";
import type {
	AutocompleteItem,
	AutocompleteProvider,
} from "../packages/tui/src/autocomplete.js";
import { Editor } from "../packages/tui/src/components/editor.js";
import { CustomEditor } from "../src/tui/custom-editor.js";

class StubAutocomplete implements AutocompleteProvider {
	getSuggestions(): { items: AutocompleteItem[]; prefix: string } | null {
		return {
			items: [{ value: "cmd", label: "cmd" }],
			prefix: "",
		};
	}
	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		return { lines, cursorLine, cursorCol };
	}
}

class ExposedEditor extends Editor {
	getCursor() {
		const state = (
			this as unknown as { state: { cursorLine: number; cursorCol: number } }
		).state;
		return { line: state.cursorLine, col: state.cursorCol };
	}
}

describe("arrow key normalization", () => {
	it("routes SS3 up/down to history navigation only when autocomplete is hidden", () => {
		const editor = new CustomEditor();
		editor.setAutocompleteProvider(new StubAutocomplete());

		let historyCalls = 0;
		editor.onHistoryNavigate = () => {
			historyCalls += 1;
			return true;
		};

		// Trigger autocomplete (tab forces a suggestion list)
		editor.handleInput("\t");
		expect(editor.isShowingAutocomplete()).toBe(true);

		editor.handleInput("\x1bOA"); // SS3 Up
		expect(historyCalls).toBe(0);

		// Clear autocomplete state
		editor.setText("");
		editor.handleInput("\x1b"); // Esc cancels any active autocomplete list
		expect(editor.isShowingAutocomplete()).toBe(false);

		editor.handleInput("\x1bOA"); // SS3 Up
		expect(historyCalls).toBe(1);
	});

	it("moves the cursor with SS3 arrow sequences", () => {
		const editor = new ExposedEditor();
		editor.setText("first\nsecond");

		editor.handleInput("\x1bOA"); // Up (SS3)
		expect(editor.getCursor().line).toBe(0);

		editor.handleInput("\x1bOB"); // Down (SS3)
		expect(editor.getCursor().line).toBe(1);
	});
});
