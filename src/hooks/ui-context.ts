/**
 * Hook UI Context Implementations
 *
 * Provides interactive UI methods for hooks to prompt users.
 * Different implementations for different modes (TUI, RPC, etc.)
 *
 * @module hooks/ui-context
 */

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
	};
}

/**
 * Create a console-based UI context for CLI/testing.
 * Uses readline for interactive prompts.
 */
export function createConsoleUIContext(): HookUIContext {
	return {
		async select(title: string, options: string[]): Promise<string | null> {
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
						resolve(options[index]);
					} else {
						resolve(null);
					}
				});
			});
		},

		async confirm(title: string, message: string): Promise<boolean> {
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
					resolve(
						answer.toLowerCase() === "y" || answer.toLowerCase() === "yes",
					);
				});
			});
		},

		async input(title: string, placeholder?: string): Promise<string | null> {
			const readline = await import("node:readline");
			const rl = readline.createInterface({
				input: process.stdin,
				output: process.stdout,
			});

			return new Promise((resolve) => {
				const prompt = placeholder
					? `${title} (${placeholder}): `
					: `${title}: `;

				rl.question(prompt, (answer) => {
					rl.close();
					resolve(answer || null);
				});
			});
		},

		notify(message: string, type?: "info" | "warning" | "error"): void {
			const prefix =
				type === "error" ? "ERROR" : type === "warning" ? "WARNING" : "INFO";
			console.log(`[${prefix}] ${message}`);
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
