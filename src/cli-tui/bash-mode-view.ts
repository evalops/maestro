import { statSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
	type AutocompleteProvider,
	type Container,
	Spacer,
	type TUI,
	Text,
} from "@evalops/tui";
import chalk from "chalk";
import { badge, heading, italic, muted } from "../style/theme.js";
import { BashShellBlock } from "./bash-shell-block.js";
import {
	type BackgroundLaunchSource,
	parseBackgroundPrefixCommand,
	startBackgroundTask,
	stripBackgroundSuffix,
} from "./bash/background-launcher.js";
import {
	BashAutocompleteProvider,
	appendToHistory,
	highlightBashCommand,
	loadBashHistory,
} from "./bash/index.js";
import type { CustomEditor } from "./custom-editor.js";
import type { ShellCommandResult } from "./run/run-shell-command.js";
import { runStreamingShellCommand } from "./run/streaming-shell-command.js";

interface BashModeViewOptions {
	chatContainer: Container;
	ui: TUI;
	showInfoMessage: (message: string) => void;
	onStateChange: (active: boolean) => void;
	onFooterUpdate?: (info: BashModeFooterInfo | null) => void;
	editor: CustomEditor;
	defaultAutocomplete: AutocompleteProvider;
}

export interface BashModeFooterInfo {
	cwd: string;
	lastExitCode: number | null;
	isRunning: boolean;
	elapsedMs?: number;
}

/**
 * Presents a lightweight REPL-like view that proxies chat input to bash.
 * When active, every submitted line runs as a shell command until the user exits.
 *
 * Features:
 * - Streaming output (real-time stdout/stderr display)
 * - Persistent command history (~/.composer/bash-history.json)
 * - Enhanced autocomplete (executables, git, npm scripts)
 * - Syntax highlighting for commands
 * - Environment variable persistence within session
 * - Background task support (!& prefix)
 */
export class BashModeView {
	private active = false;
	private currentCwd: string;
	private readonly projectRoot: string;
	private readonly homeDir: string;
	private readonly defaultAutocomplete: AutocompleteProvider;
	private bashAutocomplete?: BashAutocompleteProvider;
	private history: string[] = [];
	private historyIndex: number | null = null;
	private draftCommand = "";
	private pendingDraft: string | null = null;
	private applyingHistory = false;
	private lastExitCode: number | null = null;
	private isRunning = false;
	private currentAbortController: AbortController | null = null;
	private sessionEnv: Record<string, string> = {};
	private streamUpdateInterval: NodeJS.Timeout | null = null;
	private static readonly EXIT_COMMANDS = new Set(["exit", "quit", "leave"]);
	private static readonly CLEAR_COMMANDS = new Set(["clear", "cls"]);

	constructor(private readonly options: BashModeViewOptions) {
		this.projectRoot = this.normalizePath(process.cwd());
		const rawHome = process.env.HOME ?? process.cwd();
		this.homeDir = this.normalizePath(rawHome);
		this.currentCwd = this.projectRoot;
		this.defaultAutocomplete = options.defaultAutocomplete;
		this.options.editor.onHistoryNavigate = (direction) =>
			this.handleHistoryNavigate(direction);
		this.options.editor.onChange = (text) => this.handleEditorChange(text);
		// Load persistent history
		this.history = loadBashHistory();
	}

	isActive(): boolean {
		return this.active;
	}

	isCommandRunning(): boolean {
		return this.isRunning;
	}

	getCurrentCwd(): string {
		return this.currentCwd;
	}

	getLastExitCode(): number | null {
		return this.lastExitCode;
	}

	/**
	 * Abort the currently running command (if any).
	 */
	abortCurrentCommand(): boolean {
		this.stopStreamUpdates();
		if (this.currentAbortController) {
			this.currentAbortController.abort();
			this.currentAbortController = null;
			return true;
		}
		return false;
	}

	async tryHandleInput(rawInput: string): Promise<boolean> {
		const prefixBackgroundCommand = !this.active
			? parseBackgroundPrefixCommand(rawInput)
			: null;
		if (!this.active && prefixBackgroundCommand) {
			this.history = appendToHistory(this.history, prefixBackgroundCommand);
			this.launchBackgroundTaskCommand({
				command: prefixBackgroundCommand,
				source: "prefix",
				cwd: this.projectRoot,
				env: process.env,
			});
			return true;
		}
		if (!this.active && !rawInput.startsWith("!")) {
			return false;
		}

		if (!this.active) {
			this.enterBashMode();
			this.renderSystemMessage(
				`${heading("Bash mode enabled")}
${muted(`cwd ${this.formatDisplayPath(this.currentCwd)}`)}
${muted("Shift+Enter inserts a newline. Type exit to return to chat.")}
${muted("Ctrl+C aborts running commands.")}`,
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

		// Handle clear command
		if (BashModeView.CLEAR_COMMANDS.has(trimmed.toLowerCase())) {
			this.options.chatContainer.clear();
			this.options.ui.requestRender();
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
		this.sessionEnv = {}; // Reset session env
		this.options.editor.setLargePasteMode("verbatim");
		this.enableBashAutocomplete();
		this.options.onStateChange(true);
		this.updateFooter();
		this.options.showInfoMessage("Entered bash mode. Type exit to leave.");
	}

	private exitBashMode(): void {
		if (!this.active) {
			return;
		}
		// Abort any running command
		this.abortCurrentCommand();
		this.stopStreamUpdates();
		this.active = false;
		this.resetHistoryNavigation(true);
		this.options.editor.setLargePasteMode("placeholder");
		this.disableBashAutocomplete();
		this.renderSystemMessage(
			`${heading("Exited bash mode")}
${muted("Back to normal chat.")}`,
		);
		this.options.onStateChange(false);
		this.options.onFooterUpdate?.(null);
		this.options.showInfoMessage("Exited bash mode.");
	}

	private updateFooter(): void {
		this.options.onFooterUpdate?.({
			cwd: this.formatDisplayPath(this.currentCwd),
			lastExitCode: this.lastExitCode,
			isRunning: this.isRunning,
		});
	}

	private renderSystemMessage(message: string): void {
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(message, 1, 0));
		this.options.ui.requestRender();
	}

	private launchBackgroundTaskCommand(options: {
		command: string;
		source: BackgroundLaunchSource;
		cwd: string;
		env?: NodeJS.ProcessEnv;
	}): void {
		try {
			const task = startBackgroundTask(options.command, {
				cwd: options.cwd,
				env: options.env,
			});
			this.lastExitCode = 0;
			if (this.active) {
				this.updateFooter();
			}
			this.renderBackgroundTaskStart({
				taskId: task.id,
				command: task.command,
				cwd: options.cwd,
				source: options.source,
			});
		} catch (error) {
			this.lastExitCode = 1;
			if (this.active) {
				this.updateFooter();
			}
			this.renderBackgroundTaskFailure(options.command, error);
		}
	}

	private renderBackgroundTaskStart(details: {
		taskId: string;
		command: string;
		cwd: string;
		source: BackgroundLaunchSource;
	}): void {
		const lines = [heading("Background task started")];
		const sourceLine =
			details.source === "prefix"
				? muted("Launched via !& (detached command)")
				: muted("Launched via trailing & (detached command)");
		lines.push(sourceLine);
		lines.push(
			`${badge("Task", details.taskId, "info")} ${muted(details.command)}`,
		);
		lines.push(muted(`cwd ${this.formatDisplayPath(details.cwd)}`));
		lines.push(
			muted("Use /background list or /background logs <id> to monitor."),
		);
		this.renderSystemMessage(lines.join("\n"));
	}

	private renderBackgroundTaskFailure(command: string, error: unknown): void {
		const description =
			error instanceof Error ? error.message : String(error ?? "unknown");
		const lines = [
			heading("Background task failed to start"),
			muted(command),
			chalk.hex("#f87171")(description || "Unable to start background task."),
		];
		this.renderSystemMessage(lines.join("\n"));
	}

	private async executeCommand(command: string): Promise<void> {
		const strippedBackgroundCommand = stripBackgroundSuffix(command);
		const normalizedCommand = strippedBackgroundCommand ?? command;

		// Record to persistent history with normalized command (no trailing &)
		this.history = appendToHistory(this.history, normalizedCommand);

		// Background tasks take precedence over export handling
		if (strippedBackgroundCommand) {
			this.launchBackgroundTaskCommand({
				command: strippedBackgroundCommand,
				source: "suffix",
				cwd: this.currentCwd,
				env: { ...process.env, ...this.sessionEnv },
			});
			this.resetHistoryNavigation(true);
			return;
		}

		// Handle export commands for session env persistence
		const exportResult = this.handleExport(normalizedCommand);
		if (exportResult) {
			this.renderExportResult(exportResult);
			this.resetHistoryNavigation(true);
			return;
		}

		const promptLine = this.formatPrompt(normalizedCommand);
		const block = new BashShellBlock(
			this.formatDisplayPath(this.currentCwd),
			`${promptLine}\n${muted("Running…")}`,
		);
		block.setPromptLine(promptLine);
		block.setStatus("pending");
		this.options.chatContainer.addChild(block);
		this.options.ui.requestRender();

		// Check for builtin commands first
		const builtinResult = this.handleBuiltin(normalizedCommand);
		if (builtinResult) {
			this.lastExitCode = builtinResult.code;
			const statusLine = badge(
				"Exit code",
				String(builtinResult.code),
				builtinResult.success ? "success" : "danger",
			);
			const body = [builtinResult.stdout, builtinResult.stderr]
				.filter(Boolean)
				.join("\n");
			let content = `${promptLine}\n${body || muted("(no output)")}\n\n${statusLine}`;
			if (builtinResult.cwdChanged) {
				const cwdLine = italic(
					`cwd → ${this.formatDisplayPath(this.currentCwd)}`,
				);
				content = `${promptLine}\n${cwdLine}\n${body || muted("(no output)")}\n\n${statusLine}`;
			}
			block.setBody(content);
			block.setStatus(builtinResult.success ? "success" : "error");
			this.updateFooter();
			this.options.ui.requestRender();
			this.resetHistoryNavigation(true);
			return;
		}

		// Run command with streaming output
		this.isRunning = true;
		this.currentAbortController = new AbortController();
		this.updateFooter();

		// Start spinner update interval for animated display
		this.streamUpdateInterval = setInterval(() => {
			block.appendStreamOutput(""); // Trigger display update for spinner
			this.options.ui.requestRender();
		}, 80);

		const mergedEnv = { ...process.env, ...this.sessionEnv };
		const result = await runStreamingShellCommand(normalizedCommand, {
			cwd: this.currentCwd,
			env: mergedEnv,
			signal: this.currentAbortController.signal,
			onStdout: (chunk) => {
				block.appendStreamOutput(chunk);
				this.options.ui.requestRender();
			},
			onStderr: (chunk) => {
				block.appendStreamOutput(chalk.hex("#ff8c69")(chunk));
				this.options.ui.requestRender();
			},
		});

		// Clear update interval
		this.stopStreamUpdates();

		this.isRunning = false;
		this.currentAbortController = null;
		this.lastExitCode = result.code;
		this.updateFooter();

		// Build final output
		const elapsedMs = block.getElapsedMs();
		const elapsed =
			elapsedMs < 1000 ? `${elapsedMs}ms` : `${(elapsedMs / 1000).toFixed(1)}s`;
		const statusLine = badge(
			"Exit code",
			String(result.code),
			result.success ? "success" : "danger",
		);
		const timeLabel = muted(`(${elapsed})`);
		const body = [result.stdout, result.stderr].filter(Boolean).join("\n");

		block.clearStreamBuffer();
		block.setBody(
			`${promptLine}\n${body || muted("(no output)")}\n\n${statusLine} ${timeLabel}`,
		);
		block.setStatus(result.success ? "success" : "error");
		this.options.ui.requestRender();
		this.resetHistoryNavigation(true);
	}

	private stopStreamUpdates(): void {
		if (this.streamUpdateInterval) {
			clearInterval(this.streamUpdateInterval);
			this.streamUpdateInterval = null;
		}
	}

	private handleExport(command: string): { key: string; value: string } | null {
		const exportMatch = command.match(
			/^export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/,
		);
		if (!exportMatch) {
			return null;
		}
		const key = exportMatch[1];
		let value = exportMatch[2];
		// Strip surrounding quotes if present (only if length > 1 to avoid single quote edge case)
		if (
			value.length > 1 &&
			((value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'")))
		) {
			value = value.slice(1, -1);
		}
		this.sessionEnv[key] = value;
		return { key, value };
	}

	private renderExportResult(result: { key: string; value: string }): void {
		const message = `${heading("Environment variable set")}
${muted(`${result.key}=${result.value}`)}
${muted("(persists for this bash mode session)")}`;
		this.renderSystemMessage(message);
		this.lastExitCode = 0;
		this.updateFooter();
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
		const cmd = highlightBashCommand(command);
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
			this.bashAutocomplete = new BashAutocompleteProvider(
				this.currentCwd,
				this.history,
			);
			this.options.editor.setAutocompleteProvider(this.bashAutocomplete);
		} else {
			this.bashAutocomplete.setBasePath(this.currentCwd);
			this.bashAutocomplete.setHistory(this.history);
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
