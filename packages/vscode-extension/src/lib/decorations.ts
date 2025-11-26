import * as vscode from "vscode";

export class ThinkingManager implements vscode.Disposable {
	private decorationType: vscode.TextEditorDecorationType;
	private thinkingLines: Map<string, number[]> = new Map(); // uri -> line numbers
	private disposables: vscode.Disposable[] = [];

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

		// Clean up stored lines when a document is closed to prevent leaks
		this.disposables.push(
			vscode.workspace.onDidCloseTextDocument((doc) => {
				this.thinkingLines.delete(doc.uri.toString());
			}),
		);

		// Clear decorations on any edit to prevent line number invalidation/staleness
		// It's safer to clear thinking indicators if the user starts typing
		this.disposables.push(
			vscode.workspace.onDidChangeTextDocument((e) => {
				const uri = e.document.uri.toString();
				if (this.thinkingLines.has(uri)) {
					this.thinkingLines.delete(uri);
					// We find the editor for this document and update (clear) decorations
					for (const editor of vscode.window.visibleTextEditors) {
						if (editor.document.uri.toString() === uri) {
							this.updateDecorations(editor);
						}
					}
				}
			}),
		);
	}

	public setThinking(editor: vscode.TextEditor, line: number) {
		if (line < 0) return;
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
				if (lines.length === 0) {
					this.thinkingLines.delete(uri);
				} else {
					this.thinkingLines.set(uri, lines);
				}
			}
		} else {
			this.thinkingLines.delete(uri);
		}
		this.updateDecorations(editor);
	}

	private updateDecorations(editor: vscode.TextEditor) {
		const uri = editor.document.uri.toString();
		const lines = this.thinkingLines.get(uri) || [];
		const lineCount = editor.document.lineCount;
		if (lineCount === 0) {
			this.thinkingLines.delete(uri);
			editor.setDecorations(this.decorationType, []);
			return;
		}

		const validLines = lines.filter((line) => line >= 0 && line < lineCount);
		if (validLines.length === 0) {
			this.thinkingLines.delete(uri);
			editor.setDecorations(this.decorationType, []);
			return;
		}
		if (validLines.length !== lines.length) {
			this.thinkingLines.set(uri, validLines);
		}

		const ranges = validLines.map((line) => editor.document.lineAt(line).range);
		editor.setDecorations(this.decorationType, ranges);
	}

	public dispose() {
		this.decorationType.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
		this.thinkingLines.clear();
	}
}
