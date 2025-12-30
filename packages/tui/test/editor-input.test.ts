import { describe, expect, it } from "vitest";

import { Editor } from "../src/components/editor.js";

describe("Editor input handling", () => {
	it("does not treat ANSI arrow sequences as paste bursts", () => {
		const editor = new Editor();
		// Simulate Up/Down arrow escape sequences arriving as a single chunk
		editor.handleInput("\x1b[A");
		editor.handleInput("\x1b[B");

		// No stray "[A" or "[B" should be inserted into the buffer
		expect(editor.getText()).toBe("");
	});

	it("handles SS3 arrow sequences without inserting text", () => {
		const editor = new Editor();
		// SS3 sequences used in application cursor mode
		editor.handleInput("\x1bOA"); // Up
		editor.handleInput("\x1bOB"); // Down
		editor.handleInput("\x1bOC"); // Right
		editor.handleInput("\x1bOD"); // Left

		expect(editor.getText()).toBe("");
	});

	it("moves and deletes grapheme clusters safely", () => {
		const editor = new Editor();
		editor.setText("a🙂b");

		// Move left to just before "b", then backspace removes the emoji.
		editor.handleInput("\x1b[D");
		editor.handleInput("\x7f");
		expect(editor.getText()).toBe("ab");

		// Reset and delete forward from after "a".
		editor.setText("a🙂b");
		editor.handleInput("\x1b[D"); // before "b"
		editor.handleInput("\x1b[D"); // after "a"
		editor.handleInput("\x1b[3~"); // forward delete
		expect(editor.getText()).toBe("ab");

		const state = editor as unknown as {
			state: { cursorCol: number };
		};
		expect(state.state.cursorCol).toBe(1);
	});
});
