import { describe, expect, it } from "vitest";
import { Editor } from "../../packages/tui/src/components/editor.js";

// Access private methods for targeted behavior tests
type EditorPrivate = Editor & {
	state: {
		lines: string[];
		cursorLine: number;
		cursorCol: number;
	};
	moveWordBackwards: () => void;
	moveWordForwards: () => void;
};

describe("Editor word navigation across lines", () => {
	it("moves backward across line boundary to previous line end", () => {
		const editor = new Editor() as EditorPrivate;
		editor.state.lines = ["hello", "world"];
		editor.state.cursorLine = 1;
		editor.state.cursorCol = 0; // at start of second line

		editor.moveWordBackwards();

		expect(editor.state.cursorLine).toBe(0);
		expect(editor.state.cursorCol).toBe(0); // start of "hello"
	});

	it("moves forward across line boundary to next line word end", () => {
		const editor = new Editor() as EditorPrivate;
		editor.state.lines = ["hello", "world"];
		editor.state.cursorLine = 0;
		editor.state.cursorCol = 5; // end of first line

		editor.moveWordForwards();

		expect(editor.state.cursorLine).toBe(1);
		expect(editor.state.cursorCol).toBe(5); // end of "world"
	});
});
