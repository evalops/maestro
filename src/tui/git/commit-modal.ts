import type { Component } from "@evalops/tui";
import { theme } from "../../theme/theme.js";
import { CustomEditor } from "../custom-editor.js";
import { centerText } from "../utils/text-formatting.js";

interface CommitModalOptions {
	onSubmit: (message: string) => void;
	onCancel: () => void;
}

export class CommitModal implements Component {
	private editor: CustomEditor;

	constructor(private readonly options: CommitModalOptions) {
		this.editor = new CustomEditor();
		this.editor.placeholder = "Enter commit message (required)";
		this.editor.onSubmit = (text) => {
			const trimmed = text.trim();
			if (!trimmed) {
				// Visual feedback for empty input?
				// CustomEditor doesn't expose error state yet, but we can shake/flash or just ignore.
				// For now, we just ignore. The placeholder signals it's required.
				return;
			}
			this.options.onSubmit(trimmed);
		};
		this.editor.setText(""); // Ensure empty start
	}

	render(width: number): string[] {
		const lines: string[] = [];
		// Top border
		lines.push(theme.fg("borderAccent", `╭${"─".repeat(width - 2)}╮`));

		const title = centerText("COMMIT MESSAGE", width - 4);
		lines.push(
			`${theme.fg("borderAccent", "│ ")}${theme.bold(theme.fg("text", title))}${theme.fg("borderAccent", " │")}`,
		);

		lines.push(theme.fg("borderAccent", `├${"─".repeat(width - 2)}┤`));

		// Render editor content (it usually returns an array of lines)
		// We need to give it space.
		const editorLines = this.editor.render(width - 4);
		for (const line of editorLines) {
			lines.push(
				`${theme.fg("borderAccent", "│ ")}${line}${theme.fg("borderAccent", " │")}`,
			);
		}

		// Pad to minimum height if needed
		const minHeight = 5;
		if (editorLines.length < minHeight) {
			for (let i = 0; i < minHeight - editorLines.length; i++) {
				lines.push(
					`${theme.fg("borderAccent", "│ ")}${" ".repeat(width - 4)}${theme.fg("borderAccent", " │")}`,
				);
			}
		}

		// Bottom separator
		lines.push(theme.fg("borderAccent", `├${"─".repeat(width - 2)}┤`));

		const helpText = "[enter] commit  [esc] cancel";
		lines.push(
			`${theme.fg("borderAccent", "│ ")}${centerText(theme.fg("dim", helpText), width - 4)}${theme.fg("borderAccent", " │")}`,
		);

		lines.push(theme.fg("borderAccent", `╰${"─".repeat(width - 2)}╯`));
		return lines;
	}

	handleInput(data: string): void {
		if (data === "\x1b") {
			this.options.onCancel();
			return;
		}
		this.editor.handleInput(data);
	}
}
