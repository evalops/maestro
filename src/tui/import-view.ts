import chalk from "chalk";
import { exportSessionToHtml, exportSessionToText } from "../export-html.js";
import { importFactoryConfig } from "../factory/index.js";
import type { Agent } from "../agent/agent.js";
import type { SessionManager } from "../session-manager.js";
import type { Container, TUI } from "../tui-lib/index.js";
import { Spacer, Text } from "../tui-lib/index.js";
import { reloadModelConfig } from "../models/registry.js";

interface ImportExportViewOptions {
	agent: Agent;
	sessionManager: SessionManager;
	chatContainer: Container;
	ui: TUI;
	showInfoMessage: (message: string) => void;
	applyLoadedSessionContext: () => void;
}

export class ImportExportView {
	constructor(private readonly options: ImportExportViewOptions) {}

	handleExportCommand(text: string): void {
		const parts = text.split(/\s+/);
		let mode: "html" | "text" = "html";
		let outputPath: string | undefined;
		if (parts.length > 1) {
			if (
				parts[1].toLowerCase() === "lite" ||
				parts[1].toLowerCase() === "text"
			) {
				mode = "text";
				outputPath = parts[2];
			} else {
				outputPath = parts[1];
			}
		}

		try {
			const filePath =
				mode === "text"
					? exportSessionToText(
							this.options.sessionManager,
							this.options.agent.state,
							outputPath,
						)
					: exportSessionToHtml(
							this.options.sessionManager,
							this.options.agent.state,
							outputPath,
						);

			this.options.chatContainer.addChild(new Spacer(1));
			this.options.chatContainer.addChild(
				new Text(chalk.dim(`Session exported to: ${filePath}`), 1, 0),
			);
			this.options.ui.requestRender();
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error ?? "unknown");
			this.options.chatContainer.addChild(new Spacer(1));
			this.options.chatContainer.addChild(
				new Text(
					chalk.red(`Failed to export session: ${message}`),
					1,
					0,
				),
			);
			this.options.ui.requestRender();
		}
	}

	handleImportCommand(text: string): void {
		const parts = text.trim().split(/\s+/);
		const source = parts[1]?.toLowerCase();
		if (!source || source === "help") {
			this.options.showInfoMessage("Usage: /import factory");
			return;
		}
		if (source === "factory") {
			try {
				const result = importFactoryConfig();
				this.options.applyLoadedSessionContext();
				this.options.showInfoMessage(
					`Imported ${result.modelCount} model${result.modelCount === 1 ? "" : "s"} from Factory into ${result.targetPath}.`,
				);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : String(error ?? "unknown");
				this.options.showInfoMessage(
					chalk.red(`Factory import failed: ${message}`),
				);
			}
			return;
		}
		this.options.showInfoMessage(
			`Unknown import source "${source}". Supported sources: factory`,
		);
	}
}
