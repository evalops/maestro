import * as vscode from "vscode";

export class ThinkingManager {
	private decorationType: vscode.TextEditorDecorationType;
	private thinkingLines: Map<string, number[]> = new Map(); // uri -> line numbers

	constructor() {
		this.decorationType = vscode.window.createTextEditorDecorationType({
			isWholeLine: true,
			after: {
				contentText: "  Thinking...",
				color: new vscode.ThemeColor("editorCodeLens.foreground"),
				margin: "0 0 0 20px",
				fontStyle: "italic",
			},
			backgroundColor: new vscode.ThemeColor("editor.lineHighlightBackground"),
			overviewRulerColor: new vscode.ThemeColor(
				"editorOverviewRuler.infoForeground",
			),
			overviewRulerLane: vscode.OverviewRulerLane.Right,
		});
	}

	public setThinking(editor: vscode.TextEditor, line: number) {
		const uri = editor.document.uri.toString();
		const lines = this.thinkingLines.get(uri) || [];

		if (!lines.includes(line)) {
			lines.push(line);
			this.thinkingLines.set(uri, lines);
			this.updateDecorations(editor);
		}
	}

	public clearThinking(editor: vscode.TextEditor, line?: number) {
		const uri = editor.document.uri.toString();
		if (line !== undefined) {
			const lines = this.thinkingLines.get(uri) || [];
			const index = lines.indexOf(line);
			if (index !== -1) {
				lines.splice(index, 1);
				this.thinkingLines.set(uri, lines);
			}
		} else {
			this.thinkingLines.delete(uri);
		}
		this.updateDecorations(editor);
	}

	private updateDecorations(editor: vscode.TextEditor) {
		const uri = editor.document.uri.toString();
		const lines = this.thinkingLines.get(uri) || [];

		const ranges = lines.map((line) => {
			const range = editor.document.lineAt(line).range;
			return new vscode.Range(range.start, range.end);
		});

		editor.setDecorations(this.decorationType, ranges);
	}

	public dispose() {
		this.decorationType.dispose();
	}
}
