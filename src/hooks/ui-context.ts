/**
 * Hook UI Context Implementations
 *
 * Provides interactive UI methods for hooks to prompt users.
 * Different implementations for different modes (TUI, RPC, etc.)
 *
 * @module hooks/ui-context
 */

import { theme } from "../theme/theme.js";
import type { HookUIContext } from "./types.js";

/**
 * Request sent to RPC client for UI interactions.
 */
export interface HookUIRequest {
	type: "hook_ui_request";
	requestId: string;
	action: "select" | "confirm" | "input" | "notify";
	title: string;
	options?: string[];
	message?: string;
	placeholder?: string;
	notificationType?: "info" | "warning" | "error";
}

/**
 * Response from RPC client for UI interactions.
 */
export interface HookUIResponse {
	type: "hook_ui_response";
	requestId: string;
	/** For select: selected option or null if cancelled */
	selectedOption?: string | null;
	/** For confirm: true/false */
	confirmed?: boolean;
	/** For input: entered text or null if cancelled */
	inputText?: string | null;
}

/**
 * Handler for sending UI requests and receiving responses.
 */
export type HookUIRequestHandler = (
	request: HookUIRequest,
) => Promise<HookUIResponse>;

let requestIdCounter = 0;

/**
 * Create a UI context that sends requests to an RPC handler.
 */
export function createRpcUIContext(
	requestHandler: HookUIRequestHandler,
): HookUIContext {
	return {
		async select(title: string, options: string[]): Promise<string | null> {
			const requestId = `ui_${++requestIdCounter}`;
			const response = await requestHandler({
				type: "hook_ui_request",
				requestId,
				action: "select",
				title,
				options,
			});
			return response.selectedOption ?? null;
		},

		async confirm(title: string, message: string): Promise<boolean> {
			const requestId = `ui_${++requestIdCounter}`;
			const response = await requestHandler({
				type: "hook_ui_request",
				requestId,
				action: "confirm",
				title,
				message,
			});
			return response.confirmed ?? false;
		},

		async input(title: string, placeholder?: string): Promise<string | null> {
			const requestId = `ui_${++requestIdCounter}`;
			const response = await requestHandler({
				type: "hook_ui_request",
				requestId,
				action: "input",
				title,
				placeholder,
			});
			return response.inputText ?? null;
		},

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire-and-forget notification
			const requestId = `ui_${++requestIdCounter}`;
			requestHandler({
				type: "hook_ui_request",
				requestId,
				action: "notify",
				title: message,
				notificationType: type ?? "info",
			}).catch(() => {
				// Ignore notification errors
			});
		},
		setStatus(_key: string, _text: string | undefined): void {
			// Not supported in RPC mode yet
		},
		async custom<T>(
			_factory: (
				tui: import("@evalops/tui").TUI,
				theme: import("../theme/theme.js").Theme,
				done: (result: T) => void,
			) =>
				| import("@evalops/tui").Component
				| Promise<import("@evalops/tui").Component>,
		): Promise<T> {
			return undefined as T;
		},
		setEditorText(_text: string): void {
			// Not supported in RPC mode yet
		},
		getEditorText(): string {
			return "";
		},
		async editor(_title: string, _prefill?: string): Promise<string | null> {
			return null;
		},
		get theme() {
			return theme;
		},
	};
}

/**
 * Create a no-op UI context for non-interactive modes.
 */
export function createNoOpUIContext(): HookUIContext {
	return {
		async select(_title: string, _options: string[]): Promise<string | null> {
			return null;
		},
		async confirm(_title: string, _message: string): Promise<boolean> {
			return false;
		},
		async input(_title: string, _placeholder?: string): Promise<string | null> {
			return null;
		},
		notify(_message: string, _type?: "info" | "warning" | "error"): void {
			// No-op
		},
		setStatus(_key: string, _text: string | undefined): void {
			// No-op
		},
		async custom<T>(
			_factory: (
				tui: import("@evalops/tui").TUI,
				theme: import("../theme/theme.js").Theme,
				done: (result: T) => void,
			) =>
				| import("@evalops/tui").Component
				| Promise<import("@evalops/tui").Component>,
		): Promise<T> {
			return undefined as T;
		},
		setEditorText(_text: string): void {
			// No-op
		},
		getEditorText(): string {
			return "";
		},
		async editor(_title: string, _prefill?: string): Promise<string | null> {
			return null;
		},
		get theme() {
			return theme;
		},
	};
}

/**
 * Create a console-based UI context for CLI/testing.
 * Uses readline for interactive prompts.
 */
export function createConsoleUIContext(): HookUIContext {
	const select = async (
		title: string,
		options: string[],
	): Promise<string | null> => {
		const readline = await import("node:readline");
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});

		return new Promise((resolve) => {
			console.log(`\n${title}`);
			options.forEach((opt, i) => {
				console.log(`  ${i + 1}. ${opt}`);
			});

			rl.question("Select (number): ", (answer) => {
				rl.close();
				const index = Number.parseInt(answer, 10) - 1;
				if (index >= 0 && index < options.length) {
					resolve(options[index] ?? null);
				} else {
					resolve(null);
				}
			});
		});
	};

	const confirm = async (title: string, message: string): Promise<boolean> => {
		const readline = await import("node:readline");
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});

		return new Promise((resolve) => {
			console.log(`\n${title}`);
			console.log(message);

			rl.question("Confirm (y/n): ", (answer) => {
				rl.close();
				resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
			});
		});
	};

	const input = async (
		title: string,
		placeholder?: string,
	): Promise<string | null> => {
		const readline = await import("node:readline");
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});

		return new Promise((resolve) => {
			const prompt = placeholder ? `${title} (${placeholder}): ` : `${title}: `;

			rl.question(prompt, (answer) => {
				rl.close();
				resolve(answer || null);
			});
		});
	};

	const notify = (
		message: string,
		type?: "info" | "warning" | "error",
	): void => {
		const prefix =
			type === "error" ? "ERROR" : type === "warning" ? "WARNING" : "INFO";
		console.log(`[${prefix}] ${message}`);
	};

	return {
		select,
		confirm,
		input,
		notify,
		setStatus(_key: string, _text: string | undefined): void {
			// No-op in console mode
		},
		async custom<T>(
			_factory: (
				tui: import("@evalops/tui").TUI,
				theme: import("../theme/theme.js").Theme,
				done: (result: T) => void,
			) =>
				| import("@evalops/tui").Component
				| Promise<import("@evalops/tui").Component>,
		): Promise<T> {
			return undefined as T;
		},
		setEditorText(_text: string): void {
			// No-op in console mode
		},
		getEditorText(): string {
			return "";
		},
		async editor(title: string, prefill?: string): Promise<string | null> {
			if (prefill) {
				console.log(`\n${title}\n${prefill}`);
			}
			return input(title);
		},
		get theme() {
			return theme;
		},
	};
}

/**
 * Global UI context registry for different modes.
 */
const uiContextRegistry: Map<string, HookUIContext> = new Map();

/**
 * Register a UI context for a specific mode.
 */
export function registerUIContext(mode: string, context: HookUIContext): void {
	uiContextRegistry.set(mode, context);
}

/**
 * Get the UI context for a specific mode.
 */
export function getUIContext(mode: string): HookUIContext | undefined {
	return uiContextRegistry.get(mode);
}

/**
 * Clear all registered UI contexts.
 */
export function clearUIContextRegistry(): void {
	uiContextRegistry.clear();
}
