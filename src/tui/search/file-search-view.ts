import type { Container, TUI } from "@evalops/tui";
import { Spacer, Text } from "@evalops/tui";
import chalk from "chalk";
import type { CustomEditor } from "../custom-editor.js";
import { getWorkspaceFiles } from "../utils/workspace-files.js";
import { FileSearchComponent } from "./file-search.js";

interface FileSearchViewOptions {
	editor: CustomEditor;
	editorContainer: Container;
	chatContainer: Container;
	ui: TUI;
	showInfoMessage: (message: string) => void;
}

export class FileSearchView {
	private fileSearchComponent: FileSearchComponent | null = null;
	private workspaceFiles: string[] = [];

	constructor(private readonly options: FileSearchViewOptions) {}

	showFileSearch(): boolean {
		if (this.fileSearchComponent) return true;
		const files = this.getWorkspaceFileList();
		if (files.length === 0) {
			this.options.showInfoMessage(
				"No files found. Ensure ripgrep or find is available.",
			);
			return false;
		}
		this.fileSearchComponent = new FileSearchComponent(
			files,
			(file) => {
				this.hideFileSearch();
				this.options.editor.insertText(`${file} `);
				this.options.ui.requestRender();
			},
			() => this.hideFileSearch(),
		);
		this.options.editorContainer.clear();
		this.options.editorContainer.addChild(this.fileSearchComponent);
		this.options.ui.setFocus(this.fileSearchComponent);
		this.options.ui.requestRender();
		return true;
	}

	hideFileSearch(): void {
		if (!this.fileSearchComponent) return;
		this.options.editorContainer.clear();
		this.options.editorContainer.addChild(this.options.editor);
		this.fileSearchComponent = null;
		this.options.ui.setFocus(this.options.editor);
		this.options.ui.requestRender();
	}

	handleMentionCommand(text: string): void {
		const files = this.getWorkspaceFileList();
		if (!files.length) {
			this.options.showInfoMessage("Workspace file index is empty.");
			return;
		}
		const query = text.includes(" ")
			? text.slice(text.indexOf(" ")).trim()
			: "";
		const normalized = query.toLowerCase();
		const matches = files
			.filter((file) =>
				normalized ? file.toLowerCase().includes(normalized) : true,
			)
			.slice(0, 15);
		if (!matches.length) {
			this.options.showInfoMessage(`No files found matching "${query}".`);
			return;
		}
		const listing = matches
			.map((file, index) => `${index + 1}. @${file}`)
			.join("\n");
		const textBlock = `${chalk.bold("Mention helper")}
${listing}

Use @ in the editor for the interactive search palette.`;
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(textBlock, 1, 0));
		this.options.ui.requestRender();
	}

	private getWorkspaceFileList(): string[] {
		if (!this.workspaceFiles.length) {
			this.workspaceFiles = getWorkspaceFiles();
		}
		return this.workspaceFiles;
	}
}
