import { describe, expect, it, vi } from "vitest";
import type {
	AutocompleteItem,
	AutocompleteProvider,
} from "../packages/tui/src/autocomplete.js";
import { Editor } from "../packages/tui/src/components/editor.js";
import { CustomEditor } from "../src/cli-tui/custom-editor.js";
import { EditorView } from "../src/cli-tui/editor-view.js";
import { getQueuedFollowUpEditBindingSequence } from "../src/cli-tui/queue/queued-follow-up-edit-binding.js";

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

	it("routes queued follow-up edit shortcuts before normal navigation", () => {
		const editor = new CustomEditor();
		const shortcuts: string[] = [];
		let historyCalls = 0;
		const bindingSequence = getQueuedFollowUpEditBindingSequence();
		const otherSequence =
			bindingSequence === "\x1b[1;2D" ? "\x1b[1;3A" : "\x1b[1;2D";

		editor.onShortcut = (shortcut) => {
			shortcuts.push(shortcut);
			return true;
		};
		editor.onHistoryNavigate = () => {
			historyCalls += 1;
			return true;
		};

		editor.handleInput(bindingSequence);
		editor.handleInput(otherSequence);

		expect(shortcuts).toEqual(["edit-last-follow-up"]);
		expect(historyCalls).toBe(0);
	});

	it("treats Tab on shell drafts as a no-op instead of opening autocomplete", () => {
		const editor = new CustomEditor();
		editor.setAutocompleteProvider(new StubAutocomplete());
		editor.setText("!ls");

		new EditorView({
			editor,
			getCommandEntries: () => [],
			onFirstInput: vi.fn(),
			onSubmit: vi.fn(),
			shouldFollowUp: () => false,
			shouldInterrupt: () => false,
			showCommandPalette: vi.fn(),
			showFileSearch: vi.fn(),
		});

		editor.handleInput("\t");

		expect(editor.getText()).toBe("!ls");
		expect(editor.isShowingAutocomplete()).toBe(false);
	});
});
