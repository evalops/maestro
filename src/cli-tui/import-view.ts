import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import {
	dirname,
	isAbsolute,
	join,
	normalize,
	relative,
	resolve,
} from "node:path";
import { pathToFileURL } from "node:url";
import type { Container, TUI } from "@evalops/tui";
import { Spacer, Text } from "@evalops/tui";
import chalk from "chalk";
import type { Agent } from "../agent/agent.js";
import { PATHS } from "../config/constants.js";
import {
	exportSessionToHtml,
	exportSessionToJson,
	exportSessionToJsonl,
	exportSessionToText,
} from "../export-html.js";
import { importFactoryConfig } from "../factory/index.js";
import { reloadModelConfig } from "../models/registry.js";
import type { SessionManager } from "../session/manager.js";
import {
	expandTildePathWithHomeDir,
	getHomeDir,
} from "../utils/path-expansion.js";

interface ImportExportViewOptions {
	agent: Agent;
	sessionManager: SessionManager;
	chatContainer: Container;
	ui: TUI;
	showInfoMessage: (message: string) => void;
	applyLoadedSessionContext: () => void;
	recordShareArtifact: (filePath: string) => void;
	loadImportedSession?: (sessionFile: string) => void;
}

export class ImportExportView {
	private readonly allowedExportRoots: string[] = Array.from(
		new Set([
			normalize(resolve(process.cwd())),
			normalize(getHomeDir()),
			normalize(PATHS.MAESTRO_HOME),
			normalize(tmpdir()),
		]),
	);

	constructor(private readonly options: ImportExportViewOptions) {}

	private expandPath(input: string): string {
		if (!input) {
			return input;
		}
		const expanded = expandTildePathWithHomeDir(input, getHomeDir());
		return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
	}

	private resolveAllowedPath(
		input: string,
		action: "Export" | "Import",
	): string {
		const expanded = this.expandPath(input);
		const resolvedPath = normalize(resolve(expanded));
		if (!this.isAllowedExportPath(resolvedPath)) {
			throw new Error(
				`${action} path must be inside one of: ${this.allowedExportRoots.join(
					", ",
				)}.`,
			);
		}
		return resolvedPath;
	}

	private resolveExportPath(input: string): string {
		return this.resolveAllowedPath(input, "Export");
	}

	private resolveImportPath(input: string): string {
		return this.resolveAllowedPath(input, "Import");
	}

	private isAllowedExportPath(targetPath: string): boolean {
		return this.allowedExportRoots.some((root) => {
			const relativePath = relative(root, targetPath);
			return (
				relativePath === "" ||
				(!relativePath.startsWith("..") && !isAbsolute(relativePath))
			);
		});
	}

	async handleExportCommand(text: string): Promise<void> {
		const tokens = text.trim().split(/\s+/).filter(Boolean);
		if (tokens[0]?.startsWith("/")) {
			tokens.shift();
		}
		let mode: "html" | "text" | "json" | "jsonl" = "html";
		let outputToken: string | undefined;
		for (const token of tokens) {
			const normalized = token.toLowerCase();
			if (normalized === "html") {
				mode = "html";
				continue;
			}
			if (normalized === "text" || normalized === "lite") {
				mode = "text";
				continue;
			}
			if (normalized === "jsonl") {
				mode = "jsonl";
				continue;
			}
			if (normalized === "json") {
				mode = "json";
				continue;
			}
			if (!outputToken) {
				outputToken = token;
			}
		}

		try {
			const outputPath = outputToken
				? this.resolveExportPath(outputToken)
				: undefined;
			if (outputPath) {
				mkdirSync(dirname(outputPath), { recursive: true });
			}
			let filePath: string;
			switch (mode) {
				case "text":
					filePath = await exportSessionToText(
						this.options.sessionManager,
						this.options.agent.state,
						outputPath,
					);
					break;
				case "jsonl":
					filePath = await exportSessionToJsonl(
						this.options.sessionManager,
						outputPath,
					);
					break;
				case "json":
					filePath = await exportSessionToJson(
						this.options.sessionManager,
						outputPath,
					);
					break;
				default:
					filePath = await exportSessionToHtml(
						this.options.sessionManager,
						this.options.agent.state,
						outputPath,
					);
					break;
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
			this.options.showInfoMessage(
				"Usage: /import factory | /import session <file.json|file.jsonl>",
			);
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
		if (source === "session") {
			const sourcePath = parts.slice(2).join(" ").trim();
			if (!sourcePath) {
				this.options.showInfoMessage(
					"Usage: /import session <file.json|file.jsonl>",
				);
				return;
			}
			try {
				const resolvedPath = this.resolveImportPath(sourcePath);
				const imported =
					this.options.sessionManager.importPortableSession(resolvedPath);
				this.options.loadImportedSession?.(imported.sessionFile);
				this.options.showInfoMessage(
					`Imported session ${imported.sessionId} from ${resolvedPath}.`,
				);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : String(error ?? "unknown");
				this.options.showInfoMessage(
					chalk.red(`Session import failed: ${message}`),
				);
			}
			return;
		}
		this.options.showInfoMessage(
			`Unknown import source "${source}". Supported sources: factory, session`,
		);
	}

	async handleShareCommand(text: string): Promise<void> {
		const parts = text.trim().split(/\s+/);
		const customTarget = parts[1];
		const baseDir = join(PATHS.MAESTRO_HOME, "share");
		let outputPath: string;
		try {
			if (customTarget) {
				outputPath = this.resolveExportPath(customTarget);
				mkdirSync(dirname(outputPath), { recursive: true });
			} else {
				mkdirSync(baseDir, { recursive: true });
				const timestamp = new Date()
					.toISOString()
					.replace(/[:.]/g, "-")
					.replace("T", "_")
					.replace("Z", "");
				outputPath = join(baseDir, `maestro-share-${timestamp}.html`);
			}

			const filePath = await exportSessionToHtml(
				this.options.sessionManager,
				this.options.agent.state,
				outputPath,
			);
			this.options.recordShareArtifact(filePath);
			const fileUrl = pathToFileURL(filePath).toString();
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
