/**
 * TypeScript Hook Loader
 *
 * Loads TypeScript hooks using jiti for direct execution without compilation.
 * Implements the pi-mono style hook API where hooks export a default function
 * that receives an API object for registering event handlers and sending messages.
 *
 * @module hooks/typescript-loader
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createLogger } from "../utils/logger.js";
import { expandTildePath, getHomeDir } from "../utils/path-expansion.js";
import type {
	ExecResult,
	HookAPI,
	HookAttachment,
	HookEventContext,
	HookEventType,
	HookFactory,
	HookHandler,
	HookInput,
	HookJsonOutput,
	HookSendHandler,
	HookUIContext,
	LoadedTypeScriptHook,
} from "./types.js";

const logger = createLogger("hooks:typescript-loader");

/**
 * Global registry of loaded TypeScript hooks.
 */
const loadedHooks: LoadedTypeScriptHook[] = [];

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizeUnicodeSpaces(str: string): string {
	return str.replace(UNICODE_SPACES, " ");
}

/**
 * Global send handler - set by the session/mode that enables message injection.
 */
let globalSendHandler: HookSendHandler | null = null;

/**
 * Global UI context - set by the mode (TUI, RPC, etc.)
 */
let globalUIContext: HookUIContext | null = null;
let globalHasUI = false;
let globalCwd = process.cwd();
let globalSessionFile: string | null = null;

/**
 * Expand ~ to home directory in paths.
 */
function expandPath(p: string): string {
	return expandTildePath(normalizeUnicodeSpaces(p));
}

/**
 * Resolve a hook path relative to a base directory.
 */
function resolveHookPath(hookPath: string, cwd: string): string {
	const expanded = expandPath(hookPath);
	if (isAbsolute(expanded)) {
		return expanded;
	}
	return resolve(cwd, expanded);
}

/**
 * Discover TypeScript hooks in a directory.
 */
function discoverHooksInDir(dir: string): string[] {
	const expanded = expandPath(dir);
	if (!existsSync(expanded)) {
		return [];
	}

	try {
		const files = readdirSync(expanded);
		return files
			.filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
			.map((f) => join(expanded, f));
	} catch (error) {
		logger.warn("Failed to read hooks directory", {
			dir: expanded,
			error: error instanceof Error ? error.message : String(error),
		});
		return [];
	}
}

/**
 * Create the exec function for hook context.
 */
function createExecFunction(cwd: string): HookEventContext["exec"] {
	return async (command: string, args: string[]): Promise<ExecResult> => {
		return new Promise((resolve) => {
			const child = spawn(command, args, {
				cwd,
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
	};
}

/**
 * Create a no-op UI context for non-interactive modes.
 */
function createNoOpUIContext(): HookUIContext {
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
			// No-op in non-interactive modes
		},
	};
}

/**
 * Create the event context for hook handlers.
 */
function createEventContext(): HookEventContext {
	return {
		exec: createExecFunction(globalCwd),
		ui: globalUIContext ?? createNoOpUIContext(),
		hasUI: globalHasUI,
		cwd: globalCwd,
		sessionFile: globalSessionFile,
	};
}

/**
 * Load a single TypeScript hook file.
 */
async function loadTypeScriptHook(
	hookPath: string,
	cwd: string,
): Promise<LoadedTypeScriptHook | null> {
	const resolvedPath = resolveHookPath(hookPath, cwd);

	if (!existsSync(resolvedPath)) {
		logger.warn("TypeScript hook file not found", { path: resolvedPath });
		return null;
	}

	try {
		// Dynamically import jiti
		const { createJiti } = await import("jiti");
		const jiti = createJiti(import.meta.url);

		// Load the module
		const module = await jiti.import(resolvedPath, { default: true });
		const factory = module as HookFactory;

		if (typeof factory !== "function") {
			logger.warn("TypeScript hook does not export a default function", {
				path: resolvedPath,
			});
			return null;
		}

		// Create the hook registration
		const handlers = new Map<
			HookEventType,
			Array<HookHandler<HookInput, HookJsonOutput | undefined>>
		>();
		let localSendHandler: HookSendHandler | null = null;

		const api: HookAPI = {
			on<E extends HookEventType>(
				event: E,
				handler: HookHandler<HookInput, HookJsonOutput | undefined>,
			): void {
				if (!handlers.has(event)) {
					handlers.set(event, []);
				}
				handlers.get(event)?.push(handler);
			},
			send(text: string, attachments?: HookAttachment[]): void {
				const handler = localSendHandler ?? globalSendHandler;
				if (handler) {
					handler(text, attachments);
				} else {
					logger.warn("Hook called send() but no send handler is configured");
				}
			},
		};

		// Call the factory to register handlers
		factory(api);

		const hook: LoadedTypeScriptHook = {
			path: hookPath,
			resolvedPath,
			handlers,
			setSendHandler: (handler: HookSendHandler) => {
				localSendHandler = handler;
			},
		};

		logger.debug("Loaded TypeScript hook", {
			path: resolvedPath,
			eventTypes: Array.from(handlers.keys()),
		});

		return hook;
	} catch (error) {
		logger.error(
			"Failed to load TypeScript hook",
			error instanceof Error ? error : new Error(String(error)),
			{ path: resolvedPath },
		);
		return null;
	}
}

/**
 * Discover and load all TypeScript hooks.
 */
export async function discoverAndLoadTypeScriptHooks(
	configuredPaths: string[],
	cwd: string,
): Promise<{ hooks: LoadedTypeScriptHook[]; errors: string[] }> {
	const errors: string[] = [];
	const hooks: LoadedTypeScriptHook[] = [];
	const seenPaths = new Set<string>();

	// Discover global hooks
	const globalHooksDir = join(getHomeDir(), ".composer", "hooks");
	const globalHookPaths = discoverHooksInDir(globalHooksDir);

	// Discover project hooks
	const projectHooksDir = join(cwd, ".composer", "hooks");
	const projectHookPaths = discoverHooksInDir(projectHooksDir);

	// Combine all paths (global, project, configured)
	const allPaths = [
		...globalHookPaths,
		...projectHookPaths,
		...configuredPaths,
	];

	for (const hookPath of allPaths) {
		const resolved = resolveHookPath(hookPath, cwd);

		// Deduplicate
		if (seenPaths.has(resolved)) {
			continue;
		}
		seenPaths.add(resolved);

		// Only load .ts files
		if (!resolved.endsWith(".ts") || resolved.endsWith(".d.ts")) {
			continue;
		}

		const hook = await loadTypeScriptHook(hookPath, cwd);
		if (hook) {
			hooks.push(hook);
		} else {
			errors.push(`Failed to load hook: ${resolved}`);
		}
	}

	// Store in global registry
	loadedHooks.length = 0;
	loadedHooks.push(...hooks);

	logger.info("TypeScript hooks loaded", {
		count: hooks.length,
		errorCount: errors.length,
	});

	return { hooks, errors };
}

/**
 * Get all loaded TypeScript hooks.
 */
export function getLoadedTypeScriptHooks(): LoadedTypeScriptHook[] {
	return loadedHooks;
}

/**
 * Check if any TypeScript hooks have handlers for a specific event.
 */
export function hasTypeScriptHookHandlers(event: HookEventType): boolean {
	return loadedHooks.some((hook) => {
		const handlers = hook.handlers.get(event);
		return handlers !== undefined && handlers.length > 0;
	});
}

/**
 * Execute TypeScript hook handlers for an event.
 */
export async function executeTypeScriptHooks(
	event: HookEventType,
	input: HookInput,
	timeout = 30000,
): Promise<Array<HookJsonOutput | undefined>> {
	const results: Array<HookJsonOutput | undefined> = [];
	const ctx = createEventContext();

	for (const hook of loadedHooks) {
		const handlers = hook.handlers.get(event);
		if (!handlers || handlers.length === 0) {
			continue;
		}

		for (const handler of handlers) {
			try {
				// Create timeout promise
				const timeoutPromise = new Promise<undefined>((_, reject) => {
					setTimeout(() => {
						reject(new Error(`Hook handler timed out after ${timeout}ms`));
					}, timeout);
				});

				// Race handler against timeout
				const result = await Promise.race([
					handler(input, ctx),
					timeoutPromise,
				]);
				results.push(result);
			} catch (error) {
				logger.error(
					"TypeScript hook handler error",
					error instanceof Error ? error : new Error(String(error)),
					{ hookPath: hook.path, event },
				);
			}
		}
	}

	return results;
}

/**
 * Set the global send handler for message injection.
 */
export function setGlobalSendHandler(handler: HookSendHandler | null): void {
	globalSendHandler = handler;
}

/**
 * Get the current global send handler.
 */
export function getGlobalSendHandler(): HookSendHandler | null {
	return globalSendHandler;
}

/**
 * Set the global UI context for interactive hooks.
 */
export function setGlobalUIContext(
	uiContext: HookUIContext | null,
	hasUI: boolean,
): void {
	globalUIContext = uiContext;
	globalHasUI = hasUI;
}

/**
 * Set the global working directory.
 */
export function setGlobalCwd(cwd: string): void {
	globalCwd = cwd;
}

/**
 * Set the global session file path.
 */
export function setGlobalSessionFile(sessionFile: string | null): void {
	globalSessionFile = sessionFile;
}

/**
 * Clear all loaded TypeScript hooks.
 */
export function clearLoadedTypeScriptHooks(): void {
	loadedHooks.length = 0;
}
