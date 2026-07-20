import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TUI } from "@evalops/tui";

export interface ExternalEditorResult {
	updatedText?: string;
	error?: string;
}

export function openExternalEditor(
	ui: TUI,
	currentText: string,
): ExternalEditorResult {
	const editorCmd = process.env.VISUAL || process.env.EDITOR;
	if (!editorCmd) {
		return {
			error:
				"No editor configured. Set $VISUAL or $EDITOR environment variable.",
		};
	}

	let tempDir: string | undefined;

	try {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "composer-editor-"));
		const tempFile = path.join(tempDir, "input.md");
		const fd = fs.openSync(tempFile, "wx", 0o600);
		try {
			fs.writeFileSync(fd, currentText, "utf-8");
		} finally {
			fs.closeSync(fd);
		}

		ui.stop();

		const [editor, ...editorArgs] = editorCmd.split(" ");
		if (!editor) {
			return { error: "No editor command found" };
		}
		const result = spawnSync(editor, [...editorArgs, tempFile], {
			stdio: "inherit",
		});

		if (result.error) {
			return { error: result.error.message };
		}

		if (result.status === 0) {
			const newText = fs.readFileSync(tempFile, "utf-8").replace(/\n$/, "");
			return { updatedText: newText };
		}
		return {};
	} finally {
		if (tempDir) {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}
		}

		ui.start();
		ui.requestRender("interactive");
	}
}
