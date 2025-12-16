/**
 * Graceful Shutdown Manager - Clean container/process termination
 *
 * Handles SIGTERM/SIGINT signals for graceful shutdown in containerized
 * environments (Docker, Kubernetes). Ensures cleanup handlers run before
 * process exit.
 *
 * @example
 * ```typescript
 * const shutdown = createShutdownManager({ timeoutMs: 5000 });
 *
 * // Register cleanup handlers
 * shutdown.register('database', async () => {
 *   await db.close();
 * });
 *
 * shutdown.register('slack-client', async () => {
 *   await slackClient.disconnect();
 * });
 *
 * // Start listening for signals
 * shutdown.listen();
 *
 * // Or trigger manually
 * await shutdown.shutdown();
 * ```
 */

import * as logger from "../logger.js";

export type ShutdownHandler = () => Promise<void> | void;

export interface ShutdownManagerConfig {
	/** Timeout before forced exit (default: 5000ms) */
	timeoutMs?: number;
	/** Exit code on graceful shutdown (default: 0) */
	exitCode?: number;
	/** Whether to actually call process.exit (default: true, set false for testing) */
	exit?: boolean;
	/** Signals to listen for (default: ['SIGTERM', 'SIGINT']) */
	signals?: NodeJS.Signals[];
}

export interface RegisteredHandler {
	name: string;
	handler: ShutdownHandler;
	priority: number;
}

export interface ShutdownResult {
	success: boolean;
	errors: Array<{ name: string; error: Error }>;
	duration: number;
}

/**
 * Manages graceful shutdown with cleanup handlers.
 *
 * Handlers are executed in priority order (lower = earlier).
 * All handlers run even if some fail.
 */
export class ShutdownManager {
	private handlers: RegisteredHandler[] = [];
	private isShuttingDown = false;
	private hasListened = false;
	private readonly timeoutMs: number;
	private readonly exitCode: number;
	private readonly shouldExit: boolean;
	private readonly signals: NodeJS.Signals[];
	private signalHandlers: Map<NodeJS.Signals, () => void> = new Map();

	constructor(config: ShutdownManagerConfig = {}) {
		this.timeoutMs = config.timeoutMs ?? 5000;
		this.exitCode = config.exitCode ?? 0;
		this.shouldExit = config.exit ?? true;
		this.signals = config.signals ?? ["SIGTERM", "SIGINT"];
	}

	/**
	 * Register a cleanup handler.
	 *
	 * @param name Identifier for logging
	 * @param handler Async cleanup function
	 * @param priority Lower numbers run first (default: 100)
	 */
	register(name: string, handler: ShutdownHandler, priority = 100): void {
		// Remove existing handler with same name
		this.handlers = this.handlers.filter((h) => h.name !== name);
		this.handlers.push({ name, handler, priority });
		// Keep sorted by priority
		this.handlers.sort((a, b) => a.priority - b.priority);
	}

	/**
	 * Unregister a handler by name.
	 */
	unregister(name: string): boolean {
		const before = this.handlers.length;
		this.handlers = this.handlers.filter((h) => h.name !== name);
		return this.handlers.length < before;
	}

	/**
	 * Start listening for shutdown signals.
	 */
	listen(): void {
		if (this.hasListened) {
			return;
		}

		for (const signal of this.signals) {
			const handler = () => {
				logger.logInfo(`Received ${signal}, initiating graceful shutdown...`);
				this.shutdown().then((result) => {
					if (!result.success) {
						logger.logAgentError(
							"system",
							`Shutdown completed with errors: ${result.errors.map((e) => `${e.name}: ${e.error.message}`).join(", ")}`,
						);
					}
				});
			};
			this.signalHandlers.set(signal, handler);
			process.on(signal, handler);
		}

		this.hasListened = true;
	}

	/**
	 * Stop listening for shutdown signals.
	 */
	unlisten(): void {
		for (const [signal, handler] of this.signalHandlers) {
			process.off(signal, handler);
		}
		this.signalHandlers.clear();
		this.hasListened = false;
	}

	/**
	 * Execute shutdown sequence.
	 *
	 * Runs all handlers in priority order, collects errors,
	 * and optionally exits the process.
	 */
	async shutdown(): Promise<ShutdownResult> {
		if (this.isShuttingDown) {
			logger.logWarning("Shutdown already in progress");
			return { success: false, errors: [], duration: 0 };
		}

		this.isShuttingDown = true;
		const startTime = Date.now();
		const errors: Array<{ name: string; error: Error }> = [];

		logger.logInfo(
			`Starting graceful shutdown (${this.handlers.length} handlers, ${this.timeoutMs}ms timeout)`,
		);

		// Create timeout promise
		const timeoutPromise = new Promise<"timeout">((resolve) => {
			setTimeout(() => resolve("timeout"), this.timeoutMs);
		});

		// Run all handlers
		const handlersPromise = this.runHandlers(errors);

		const result = await Promise.race([handlersPromise, timeoutPromise]);

		const duration = Date.now() - startTime;

		if (result === "timeout") {
			logger.logAgentError(
				"system",
				`Shutdown timeout after ${this.timeoutMs}ms, forcing exit`,
			);
			errors.push({
				name: "_timeout",
				error: new Error(`Shutdown timed out after ${this.timeoutMs}ms`),
			});
		} else {
			logger.logInfo(`Shutdown complete in ${duration}ms`);
		}

		const success = errors.length === 0;

		if (this.shouldExit) {
			process.exit(success ? this.exitCode : 1);
		}

		return { success, errors, duration };
	}

	/**
	 * Run all handlers sequentially, collecting errors.
	 */
	private async runHandlers(
		errors: Array<{ name: string; error: Error }>,
	): Promise<void> {
		for (const { name, handler } of this.handlers) {
			try {
				logger.logDebug(`Running shutdown handler: ${name}`);
				await handler();
				logger.logDebug(`Handler completed: ${name}`);
			} catch (e) {
				const error = e instanceof Error ? e : new Error(String(e));
				logger.logAgentError(
					"system",
					`Handler failed: ${name}: ${error.message}`,
				);
				errors.push({ name, error });
			}
		}
	}

	/**
	 * Check if shutdown is in progress.
	 */
	isInProgress(): boolean {
		return this.isShuttingDown;
	}

	/**
	 * Get registered handler names.
	 */
	getHandlerNames(): string[] {
		return this.handlers.map((h) => h.name);
	}

	/**
	 * Reset state (for testing).
	 */
	reset(): void {
		this.unlisten();
		this.handlers = [];
		this.isShuttingDown = false;
	}
}

/**
 * Create a new shutdown manager instance.
 */
export function createShutdownManager(
	config?: ShutdownManagerConfig,
): ShutdownManager {
	return new ShutdownManager(config);
}

/**
 * Convenience function to create and start a shutdown manager.
 */
export function setupGracefulShutdown(
	handlers: Array<{
		name: string;
		handler: ShutdownHandler;
		priority?: number;
	}>,
	config?: ShutdownManagerConfig,
): ShutdownManager {
	const manager = createShutdownManager(config);

	for (const { name, handler, priority } of handlers) {
		manager.register(name, handler, priority);
	}

	manager.listen();
	return manager;
}
