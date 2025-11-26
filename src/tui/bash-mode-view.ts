import { statSync } from "node:fs";
import { resolve } from "node:path";
import { badge, heading, muted } from "../style/theme.js";
import { type Container, Spacer, type TUI, Text } from "../tui-lib/index.js";
import {
	type ShellCommandResult,
	runShellCommand,
} from "./run-shell-command.js";

interface BashModeViewOptions {
	chatContainer: Container;
	ui: TUI;
	showInfoMessage: (message: string) => void;
	onStateChange: (active: boolean) => void;
}

/**
 * Presents a lightweight REPL-like view that proxies chat input to bash.
 * When active, every submitted line runs as a shell command until the user exits.
 */
export class BashModeView {
	private active = false;
	private currentCwd = process.cwd();
	private static readonly EXIT_COMMANDS = new Set(["exit", "quit", "leave"]);

	constructor(private readonly options: BashModeViewOptions) {}

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
${muted("Type exit to return to chat.")}`,
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
		this.currentCwd = process.cwd();
		this.active = true;
		this.options.onStateChange(true);
		this.options.showInfoMessage("Entered bash mode. Type exit to leave.");
	}

	private exitBashMode(): void {
		if (!this.active) {
			return;
		}
		this.active = false;
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
		const prompt = heading(`[bash]$ ${command}`);
		this.options.chatContainer.addChild(new Spacer(1));
		const outputComponent = new Text(`${prompt}\n${muted("Running…")}`, 1, 0);
		this.options.chatContainer.addChild(outputComponent);
		this.options.ui.requestRender();

		const result = await this.runCommandOrBuiltin(command);
		const statusLine = badge(
			"Exit code",
			String(result.code ?? 0),
			result.success ? "success" : "danger",
		);
		const body = [result.stdout, result.stderr].filter(Boolean).join("\n");
		outputComponent.setText(
			`${prompt}\n${body || muted("(no output)")}\n\n${statusLine}`,
		);
		this.options.ui.requestRender();
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

	private handleBuiltin(command: string): ShellCommandResult | null {
		const cdMatch = command.match(/^cd(?:\s+(.*))?$/);
		if (!cdMatch) {
			return null;
		}
		try {
			this.changeDirectory(cdMatch[1]);
			return {
				success: true,
				code: 0,
				stdout: "",
				stderr: "",
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

	private changeDirectory(rawTarget?: string): void {
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
		this.currentCwd = resolvedPath;
	}
}
