/**
 * HookUiController — Manages hook UI interactions and command entries.
 *
 * Provides the HookUIContext and HookCommandContext implementations used by
 * TypeScript hooks, and builds slash-command entries for registered hook commands.
 */

import { spawn } from "node:child_process";
import type { Component, SlashCommand, TUI } from "@evalops/tui";
import { Spacer, Text } from "@evalops/tui";
import type { Agent } from "../../agent/agent.js";
import {
	getTypeScriptHookCommands,
	setGlobalUIContext,
} from "../../hooks/index.js";
import type { HookCommandContext, HookUIContext } from "../../hooks/types.js";
import type { SessionManager } from "../../session/manager.js";
import { type Theme, theme } from "../../theme/theme.js";
import { createLogger } from "../../utils/logger.js";
import type {
	CommandEntry,
	CommandExecutionContext,
} from "../commands/types.js";
import type { ModalManager } from "../modal-manager.js";
import type { NotificationView } from "../notification-view.js";
import { BaseSelectorComponent } from "../selectors/base-selector.js";
import type { FooterHint } from "../utils/footer-utils.js";

const logger = createLogger("hook-ui-controller");

// ─── Callback & Dependency Interfaces ────────────────────────────────────────

export interface HookUiControllerCallbacks {
	/** Trigger a footer hint refresh cycle. */
	refreshFooterHint: () => void;
	/** Request a UI render cycle. */
	requestRender: () => void;
}

export interface HookUiControllerDeps {
	/** The TUI instance for rendering. */
	ui: TUI;
	/** Get the current editor text. */
	getEditorText: () => string;
	/** Set the editor text content. */
	setEditorText: (text: string) => void;
	/** Modal manager for pushing/popping modal overlays. */
	modalManager: ModalManager;
	/** Agent for streaming state and abort. */
	agent: Agent;
	/** Session manager for session file path. */
	sessionManager: SessionManager;
	/** Notification view for toasts and error messages. */
	notificationView: NotificationView;
	/** Create a HookInputModal instance. */
	createHookInputModal: (options: {
		ui: TUI;
		title: string;
		placeholder?: string;
		prefill?: string;
		description?: string;
		onSubmit: (value: string) => void;
		onCancel: () => void;
	}) => Component;
	/** Build a CommandExecutionContext from raw command data. */
	createCommandContext: (params: {
		command: SlashCommand;
		rawInput: string;
		argumentText: string;
	}) => CommandExecutionContext;
}

export interface HookUiControllerOptions {
	deps: HookUiControllerDeps;
	callbacks: HookUiControllerCallbacks;
}

// ─── Controller ──────────────────────────────────────────────────────────────

export class HookUiController {
	private readonly deps: HookUiControllerDeps;
	private readonly callbacks: HookUiControllerCallbacks;
	private readonly hookStatusByKey = new Map<string, string>();
	private hookUiContext?: HookUIContext;

	constructor(options: HookUiControllerOptions) {
		this.deps = options.deps;
		this.callbacks = options.callbacks;
	}

	/** Create and register the global HookUIContext. */
	initializeGlobalContext(): void {
		this.hookUiContext = this.createHookUiContext();
		setGlobalUIContext(this.hookUiContext, true);
	}

	/** Footer hints from active hook status entries. */
	getHookStatusHints(): FooterHint[] {
		const hints: FooterHint[] = [];
		for (const text of this.hookStatusByKey.values()) {
			hints.push({ type: "custom", message: text, priority: 130 });
		}
		return hints;
	}

	/** Build slash-command entries for registered TypeScript hook commands. */
	buildHookCommandEntries(existingCommands: SlashCommand[]): {
		entries: CommandEntry[];
		commands: SlashCommand[];
	} {
		const existingNames = new Set(existingCommands.map((cmd) => cmd.name));
		const entries: CommandEntry[] = [];
		const commands: SlashCommand[] = [];
		for (const command of getTypeScriptHookCommands()) {
			if (existingNames.has(command.name)) {
				logger.warn("Skipping hook command due to name conflict", {
					name: command.name,
				});
				continue;
			}
			const slashCommand: SlashCommand = {
				name: command.name,
				description: command.description ?? "Hook command",
				usage: `/${command.name} [args]`,
				tags: ["hooks"],
			};
			const matches = (input: string) =>
				input === `/${command.name}` || input.startsWith(`/${command.name} `);
			const execute = (input: string) => {
				const argumentText = input
					.replace(new RegExp(`^/${command.name}\\s*`), "")
					.trim();
				const context = this.deps.createCommandContext({
					command: slashCommand,
					rawInput: input,
					argumentText,
				});
				if (
					argumentText === "?" ||
					argumentText === "--help" ||
					argumentText === "-h"
				) {
					context.renderHelp();
					return;
				}
				const hookContext = this.createHookCommandContext();
				const result = command.handler(argumentText, hookContext);
				if (result && typeof (result as Promise<void>).then === "function") {
					(result as Promise<void>).catch((error) => {
						context.showError(
							error instanceof Error ? error.message : String(error),
						);
					});
				}
			};
			entries.push({ command: slashCommand, matches, execute });
			commands.push(slashCommand);
			existingNames.add(command.name);
		}
		return { entries, commands };
	}

	// ─── Internal ──────────────────────────────────────────────────────────

	private createHookUiContext(): HookUIContext {
		return {
			select: (title, options) => this.showHookSelector(title, options),
			confirm: (title, message) => this.showHookConfirm(title, message),
			input: (title, placeholder) => this.showHookInput(title, placeholder),
			notify: (message, type) => {
				if (type === "error") {
					this.deps.notificationView.showError(message);
					return;
				}
				const tone = type === "warning" ? "warn" : "info";
				this.deps.notificationView.showToast(message, tone);
			},
			setStatus: (key, text) => this.setHookStatus(key, text),
			custom: (factory) => this.showHookCustom(factory),
			setEditorText: (text) => {
				this.deps.setEditorText(text);
				this.callbacks.requestRender();
			},
			getEditorText: () => this.deps.getEditorText(),
			editor: (title, prefill) => this.showHookEditor(title, prefill),
			get theme() {
				return theme;
			},
		};
	}

	private showHookSelector(
		title: string,
		options: string[],
	): Promise<string | null> {
		return new Promise((resolve) => {
			if (options.length === 0) {
				resolve(null);
				return;
			}
			const items = options.map((option) => ({
				label: option,
				value: option,
			}));
			const selector = new BaseSelectorComponent<string>({
				items,
				visibleRows: Math.min(10, items.length),
				onSelect: (value) => {
					this.deps.modalManager.pop();
					resolve(value);
				},
				onCancel: () => {
					this.deps.modalManager.pop();
					resolve(null);
				},
				prepend: [new Text(theme.fg("accent", title), 1, 0), new Spacer(1)],
			});
			this.deps.modalManager.push(selector);
		});
	}

	private showHookConfirm(title: string, message: string): Promise<boolean> {
		return new Promise((resolve) => {
			const items = [
				{ label: "Yes", value: "yes" },
				{ label: "No", value: "no" },
			];
			const selector = new BaseSelectorComponent<string>({
				items,
				visibleRows: 2,
				onSelect: (value) => {
					this.deps.modalManager.pop();
					resolve(value === "yes");
				},
				onCancel: () => {
					this.deps.modalManager.pop();
					resolve(false);
				},
				prepend: [
					new Text(theme.fg("accent", title), 1, 0),
					new Text(theme.fg("muted", message), 1, 0),
					new Spacer(1),
				],
			});
			this.deps.modalManager.push(selector);
		});
	}

	private showHookInput(
		title: string,
		placeholder?: string,
	): Promise<string | null> {
		return new Promise((resolve) => {
			const modal = this.deps.createHookInputModal({
				ui: this.deps.ui,
				title,
				placeholder,
				onSubmit: (value) => {
					this.deps.modalManager.pop();
					resolve(value);
				},
				onCancel: () => {
					this.deps.modalManager.pop();
					resolve(null);
				},
			});
			this.deps.modalManager.push(modal);
		});
	}

	private showHookEditor(
		title: string,
		prefill?: string,
	): Promise<string | null> {
		return new Promise((resolve) => {
			const modal = this.deps.createHookInputModal({
				ui: this.deps.ui,
				title,
				prefill,
				description: "Enter to save | Esc to cancel | Shift+Enter for newline",
				onSubmit: (value) => {
					this.deps.modalManager.pop();
					resolve(value);
				},
				onCancel: () => {
					this.deps.modalManager.pop();
					resolve(null);
				},
			});
			this.deps.modalManager.push(modal);
		});
	}

	private async showHookCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			done: (result: T) => void,
		) => Component | Promise<Component>,
	): Promise<T> {
		return new Promise((resolve) => {
			let resolved = false;
			const done = (result: T) => {
				if (resolved) return;
				resolved = true;
				this.deps.modalManager.pop();
				resolve(result);
			};

			void (async () => {
				try {
					const component = await factory(this.deps.ui, theme, done);
					const modal = component as Component & {
						onClose?: () => void;
					};
					const previousOnClose = modal.onClose;
					modal.onClose = () => {
						previousOnClose?.();
						if (!resolved) {
							done(undefined as T);
						}
					};
					this.deps.modalManager.push(modal);
				} catch (error) {
					this.deps.notificationView.showError(
						error instanceof Error ? error.message : "Hook custom UI failed",
					);
					resolve(undefined as T);
				}
			})();
		});
	}

	private createHookCommandContext(): HookCommandContext {
		return {
			exec: (command, args) => this.execHookCommand(command, args),
			ui: this.hookUiContext ?? this.createHookUiContext(),
			hasUI: true,
			cwd: process.cwd(),
			sessionFile: this.deps.sessionManager.getSessionFile(),
			isIdle: () => !this.deps.agent.state.isStreaming,
			abort: () => this.deps.agent.abort(),
			hasQueuedMessages: () => this.deps.agent.getQueuedMessageCount() > 0,
			waitForIdle: () => {
				if (!this.deps.agent.state.isStreaming) {
					return Promise.resolve();
				}
				return new Promise((resolve) => {
					const unsubscribe = this.deps.agent.subscribe((event) => {
						if (event.type === "agent_end") {
							unsubscribe();
							resolve();
						}
					});
				});
			},
		};
	}

	private execHookCommand(
		command: string,
		args: string[],
	): Promise<{ stdout: string; stderr: string; code: number }> {
		return new Promise((resolve) => {
			const child = spawn(command, args, {
				cwd: process.cwd(),
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";

			child.stdout?.on("data", (data) => {
				stdout += data.toString();
			});

			child.stderr?.on("data", (data) => {
				stderr += data.toString();
			});

			child.on("error", (error) => {
				resolve({
					stdout,
					stderr: `${stderr}\n${error.message}`,
					code: 1,
				});
			});

			child.on("close", (code) => {
				resolve({
					stdout,
					stderr,
					code: code ?? 1,
				});
			});
		});
	}

	private sanitizeHookStatusText(text: string): string {
		return text.replace(/[\r\n\t]+/g, " ");
	}

	private setHookStatus(key: string, text: string | undefined): void {
		if (!key) return;
		if (!text || text.trim().length === 0) {
			if (this.hookStatusByKey.delete(key)) {
				this.callbacks.refreshFooterHint();
			}
			return;
		}
		const sanitized = this.sanitizeHookStatusText(text);
		const previous = this.hookStatusByKey.get(key);
		if (previous === sanitized) {
			return;
		}
		this.hookStatusByKey.set(key, sanitized);
		this.callbacks.refreshFooterHint();
	}
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createHookUiController(
	options: HookUiControllerOptions,
): HookUiController {
	return new HookUiController(options);
}
