import { statSync } from "node:fs";
import { relative, resolve } from "node:path";
import chalk from "chalk";
import { badge, heading, muted } from "../style/theme.js";
import {
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	type Container,
	Spacer,
	type TUI,
	Text,
} from "../tui-lib/index.js";
import { BashShellBlock } from "./bash-shell-block.js";
import type { CustomEditor } from "./custom-editor.js";
import {
	type ShellCommandResult,
	runShellCommand,
} from "./run-shell-command.js";

interface BashModeViewOptions {
	chatContainer: Container;
	ui: TUI;
	showInfoMessage: (message: string) => void;
	onStateChange: (active: boolean) => void;
	editor: CustomEditor;
	defaultAutocomplete: AutocompleteProvider;
}

/**
 * Presents a lightweight REPL-like view that proxies chat input to bash.
 * When active, every submitted line runs as a shell command until the user exits.
 */
export class BashModeView {
	private active = false;
	private currentCwd: string;
	private readonly projectRoot: string;
	private readonly homeDir: string;
	private readonly defaultAutocomplete: AutocompleteProvider;
	private bashAutocomplete?: CombinedAutocompleteProvider;
	private history: string[] = [];
	private historyIndex: number | null = null;
	private draftCommand = "";
	private pendingDraft: string | null = null;
	private applyingHistory = false;
	private static readonly EXIT_COMMANDS = new Set(["exit", "quit", "leave"]);

	constructor(private readonly options: BashModeViewOptions) {
		this.projectRoot = this.normalizePath(process.cwd());
		const rawHome = process.env.HOME ?? process.cwd();
		this.homeDir = this.normalizePath(rawHome);
		this.currentCwd = this.projectRoot;
		this.defaultAutocomplete = options.defaultAutocomplete;
		this.options.editor.onHistoryNavigate = (direction) =>
			this.handleHistoryNavigate(direction);
		this.options.editor.onChange = (text) => this.handleEditorChange(text);
	}

	isActive(): boolean {
		return this.active;
	}

	async tryHandleInput(rawInput: string): Promise<boolean> {
		if (!this.active && !rawInput.startsWith("!")) {
			return false;
		}

		if (!this.active) {
			this.enterBashMode();
			this.renderSystemMessage(
				`${heading("Bash mode enabled")}
${muted(`cwd ${this.formatDisplayPath(this.currentCwd)}`)}
${muted("Shift+Enter inserts a newline. Type exit to return to chat.")}`,
			);
			const command = rawInput.slice(1).trim();
			if (!command) {
				return true;
			}
			await this.executeCommand(command);
			return true;
		}

		const trimmed = rawInput.trim();
		if (!trimmed) {
			return true;
		}

		if (BashModeView.EXIT_COMMANDS.has(trimmed.toLowerCase())) {
			this.exitBashMode();
			return true;
		}

		await this.executeCommand(trimmed);
		return true;
	}

	private enterBashMode(): void {
		if (this.active) {
			return;
		}
		this.currentCwd = this.projectRoot;
		this.active = true;
		this.options.editor.setLargePasteMode("verbatim");
		this.enableBashAutocomplete();
		this.options.onStateChange(true);
		this.options.showInfoMessage("Entered bash mode. Type exit to leave.");
	}

	private exitBashMode(): void {
		if (!this.active) {
			return;
		}
		this.active = false;
		this.resetHistoryNavigation(true);
		this.options.editor.setLargePasteMode("placeholder");
		this.disableBashAutocomplete();
		this.renderSystemMessage(
			`${heading("Exited bash mode")}
${muted("Back to normal chat.")}`,
		);
		this.options.onStateChange(false);
		this.options.showInfoMessage("Exited bash mode.");
	}

	private renderSystemMessage(message: string): void {
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(message, 1, 0));
		this.options.ui.requestRender();
	}

	private async executeCommand(command: string): Promise<void> {
		this.recordHistory(command);
		const promptLine = this.formatPrompt(command);
		const block = new BashShellBlock(
			this.formatDisplayPath(this.currentCwd),
			`${promptLine}\n${muted("Running…")}`,
		);
		block.setStatus("pending");
		this.options.chatContainer.addChild(block);
		this.options.ui.requestRender();

		const result = await this.runCommandOrBuiltin(command);
		const statusLine = badge(
			"Exit code",
			String(result.code ?? 0),
			result.success ? "success" : "danger",
		);
		const body = [result.stdout, result.stderr].filter(Boolean).join("\n");
		block.setBody(
			`${promptLine}\n${body || muted("(no output)")}\n\n${statusLine}`,
		);
		block.setStatus(result.success ? "success" : "error");
		if (result.cwdChanged) {
			const cwdLine = chalk
				.hex("#a5b4fc")
				.italic(`cwd → ${this.formatDisplayPath(this.currentCwd)}`);
			block.setBody(
				`${promptLine}\n${cwdLine}\n${body || muted("(no output)")}\n\n${statusLine}`,
			);
		}
		this.options.ui.requestRender();
		this.resetHistoryNavigation(true);
	}

	private async runCommandOrBuiltin(
		command: string,
	): Promise<ShellCommandResult> {
		const builtinResult = this.handleBuiltin(command);
		if (builtinResult) {
			return builtinResult;
		}
		return await runShellCommand(command, { cwd: this.currentCwd });
	}

	private handleBuiltin(
		command: string,
	): (ShellCommandResult & { cwdChanged?: boolean }) | null {
		const cdMatch = command.match(/^cd(?:\s+(.*))?$/);
		if (!cdMatch) {
			return null;
		}
		try {
			const changed = this.changeDirectory(cdMatch[1]);
			return {
				success: true,
				code: 0,
				stdout: "",
				stderr: "",
				cwdChanged: changed,
			};
		} catch (error) {
			return {
				success: false,
				code: 1,
				stdout: "",
				stderr:
					error instanceof Error ? error.message : String(error ?? "unknown"),
			};
		}
	}

	private changeDirectory(rawTarget?: string): boolean {
		const target = rawTarget?.trim() ?? "";
		let resolvedPath: string;
		let displayTarget = target || "~";
		if (!target || target === "~") {
			resolvedPath = process.env.HOME ?? process.cwd();
			displayTarget = "~";
		} else if (target.startsWith("~/")) {
			const home = process.env.HOME ?? process.cwd();
			resolvedPath = resolve(home, target.slice(2));
			displayTarget = target;
		} else if (target.startsWith("/")) {
			resolvedPath = target;
			displayTarget = target;
		} else {
			resolvedPath = resolve(this.currentCwd, target);
			displayTarget = target;
		}
		try {
			const stats = statSync(resolvedPath);
			if (!stats.isDirectory()) {
				throw new Error(`cd: ${displayTarget}: Not a directory`);
			}
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err?.code === "ENOENT") {
				throw new Error(`cd: ${displayTarget}: No such file or directory`);
			}
			throw new Error(
				err?.message
					? `cd: ${displayTarget}: ${err.message}`
					: `cd: ${displayTarget}: unknown error`,
			);
		}
		const normalized = this.normalizePath(resolvedPath);
		const changed = normalized !== this.currentCwd;
		this.currentCwd = normalized;
		this.bashAutocomplete?.setBasePath(this.currentCwd);
		return changed;
	}

	private formatPrompt(command: string): string {
		const cwdLabel = chalk
			.hex("#38bdf8")
			.bold(`[${this.formatDisplayPath(this.currentCwd)}]$`);
		const cmd = chalk.hex("#e2e8f0")(command);
		return `${cwdLabel} ${cmd}`.trim();
	}

	private formatDisplayPath(path: string): string {
		const normalized = this.normalizePath(path);
		const relToRoot = relative(this.projectRoot, normalized);
		if (!relToRoot || relToRoot === "") {
			return ".";
		}
		if (!relToRoot.startsWith("..")) {
			return relToRoot;
		}
		if (normalized === this.homeDir) {
			return "~";
		}
		if (normalized.startsWith(`${this.homeDir}/`)) {
			return `~/${normalized.slice(this.homeDir.length + 1)}`;
		}
		return normalized;
	}

	private normalizePath(path: string): string {
		if (path === "/") {
			return "/";
		}
		return path.replace(/\/+$/u, "");
	}

	private recordHistory(command: string): void {
		const text = command.trim();
		if (!text) {
			return;
		}
		if (this.history[this.history.length - 1] === command) {
			return;
		}
		this.history.push(command);
		if (this.history.length > 100) {
			this.history.shift();
		}
	}

	private handleHistoryNavigate(direction: "prev" | "next"): boolean {
		if (!this.active || !this.history.length) {
			return false;
		}
		if (direction === "prev") {
			if (this.historyIndex === null) {
				this.pendingDraft = this.draftCommand;
				this.historyIndex = this.history.length - 1;
			} else if (this.historyIndex > 0) {
				this.historyIndex--;
			}
		} else {
			if (this.historyIndex === null) {
				return false;
			}
			if (this.historyIndex === this.history.length - 1) {
				this.historyIndex = null;
				this.applyHistoryText(this.pendingDraft ?? "");
				this.pendingDraft = null;
				return true;
			}
			this.historyIndex++;
		}
		if (this.historyIndex !== null) {
			this.applyHistoryText(this.history[this.historyIndex]);
		}
		return true;
	}

	private applyHistoryText(text: string): void {
		this.applyingHistory = true;
		this.options.editor.setText(text);
		this.applyingHistory = false;
		this.draftCommand = text;
	}

	private handleEditorChange(text: string): void {
		this.draftCommand = text;
		if (!this.active || this.applyingHistory) {
			return;
		}
		this.resetHistoryNavigation();
	}

	private resetHistoryNavigation(clearDraft = false): void {
		this.historyIndex = null;
		this.pendingDraft = null;
		if (clearDraft) {
			this.draftCommand = "";
		}
	}

	private enableBashAutocomplete(): void {
		if (!this.bashAutocomplete) {
			this.bashAutocomplete = new CombinedAutocompleteProvider(
				[],
				this.currentCwd,
			);
			this.options.editor.setAutocompleteProvider(this.bashAutocomplete);
		} else {
			this.bashAutocomplete.setBasePath(this.currentCwd);
		}
	}

	private disableBashAutocomplete(): void {
		if (!this.bashAutocomplete) {
			this.options.editor.setAutocompleteProvider(this.defaultAutocomplete);
			return;
		}
		this.options.editor.setAutocompleteProvider(this.defaultAutocomplete);
		this.bashAutocomplete = undefined;
	}
}
