import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Container, TUI } from "@evalops/tui";
import { Spacer, Text } from "@evalops/tui";
import chalk from "chalk";
import type { Agent } from "../agent/agent.js";
import { exportSessionToHtml, exportSessionToText } from "../export-html.js";
import { importFactoryConfig } from "../factory/index.js";
import { reloadModelConfig } from "../models/registry.js";
import type { SessionManager } from "../session-manager.js";

interface ImportExportViewOptions {
	agent: Agent;
	sessionManager: SessionManager;
	chatContainer: Container;
	ui: TUI;
	showInfoMessage: (message: string) => void;
	applyLoadedSessionContext: () => void;
	recordShareArtifact: (filePath: string) => void;
}

export class ImportExportView {
	constructor(private readonly options: ImportExportViewOptions) {}

	private expandPath(input: string): string {
		if (!input) {
			return input;
		}
		if (input.startsWith("~/")) {
			return join(homedir(), input.slice(2));
		}
		return resolve(process.cwd(), input);
	}

	async handleExportCommand(text: string): Promise<void> {
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
			let filePath: string;
			if (mode === "text") {
				filePath = await exportSessionToText(
					this.options.sessionManager,
					this.options.agent.state,
					outputPath,
				);
			} else {
				filePath = await exportSessionToHtml(
					this.options.sessionManager,
					this.options.agent.state,
					outputPath,
				);
			}

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
				new Text(chalk.red(`Failed to export session: ${message}`), 1, 0),
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

	async handleShareCommand(text: string): Promise<void> {
		const parts = text.trim().split(/\s+/);
		const customTarget = parts[1];
		const baseDir = join(homedir(), ".composer", "share");
		let outputPath: string;
		if (customTarget) {
			outputPath = this.expandPath(customTarget);
			mkdirSync(dirname(outputPath), { recursive: true });
		} else {
			mkdirSync(baseDir, { recursive: true });
			const timestamp = new Date()
				.toISOString()
				.replace(/[:.]/g, "-")
				.replace("T", "_")
				.replace("Z", "");
			outputPath = join(baseDir, `composer-share-${timestamp}.html`);
		}

		try {
			const filePath = await exportSessionToHtml(
				this.options.sessionManager,
				this.options.agent.state,
				outputPath,
			);
			this.options.recordShareArtifact(filePath);
			const fileUrl = `file://${filePath}`;
			this.options.chatContainer.addChild(new Spacer(1));
			this.options.chatContainer.addChild(
				new Text(
					chalk.dim(
						`Share-ready HTML saved to ${filePath}\nOpen in browser: open ${filePath} \nURL: ${fileUrl}`,
					),
					1,
					0,
				),
			);
			this.options.ui.requestRender();
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error ?? "unknown");
			this.options.chatContainer.addChild(new Spacer(1));
			this.options.chatContainer.addChild(
				new Text(chalk.red(`Failed to create share file: ${message}`), 1, 0),
			);
			this.options.ui.requestRender();
		}
	}
}
