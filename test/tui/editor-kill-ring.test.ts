import { describe, expect, it } from "vitest";
import { Editor } from "../../packages/tui/src/components/editor.js";

describe("editor kill ring", () => {
	it("yank-pop cycles through recent kills with Alt+Y", () => {
		const editor = new Editor();

		editor.setText("alpha beta gamma");
		editor.handleInput("\x17"); // Ctrl+W
		expect(editor.getText()).toBe("alpha beta ");

		editor.setText("alpha beta delta");
		editor.handleInput("\x17"); // Ctrl+W
		expect(editor.getText()).toBe("alpha beta ");

		editor.handleInput("\x1by"); // Alt+Y (yank)
		expect(editor.getText()).toBe("alpha beta delta");

		editor.handleInput("\x1by"); // Alt+Y (yank-pop)
		expect(editor.getText()).toBe("alpha beta gamma");
	});
});
