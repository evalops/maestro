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

	const tempFile = path.join(os.tmpdir(), `composer-editor-${Date.now()}.md`);

	try {
		fs.writeFileSync(tempFile, currentText, "utf-8");

		ui.stop();

		const [editor, ...editorArgs] = editorCmd.split(" ");
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
		try {
			fs.unlinkSync(tempFile);
		} catch {
			// Ignore cleanup errors
		}

		ui.start();
		ui.requestRender("interactive");
	}
}
