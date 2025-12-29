/**
 * Typed Event Emitter - Type-safe event handling
 *
 * Provides a type-safe wrapper around Node's EventEmitter with
 * full TypeScript support for event names and payloads.
 *
 * @example
 * ```typescript
 * type MyEvents = {
 *   message: { text: string; channel: string };
 *   error: Error;
 *   connected: undefined;
 * };
 *
 * const emitter = createTypedEmitter<MyEvents>();
 *
 * // Type-safe event handling
 * emitter.on('message', (data) => {
 *   console.log(data.text); // TypeScript knows this is string
 * });
 *
 * // Type-safe emission
 * emitter.emit('message', { text: 'hello', channel: 'general' });
 * ```
 */

import { EventEmitter } from "node:events";

/**
 * Type for event handler functions.
 */
export type EventHandler<T> = T extends undefined
	? () => void
	: (data: T) => void;

/**
 * Type for async event handler functions.
 */
export type AsyncEventHandler<T> = T extends undefined
	? () => Promise<void>
	: (data: T) => Promise<void>;

/**
 * A typed event emitter that provides type safety for events.
 */
export class TypedEmitter<TEvents extends Record<string, unknown>> {
	private emitter: EventEmitter;
	private handlers: Map<
		string,
		Set<{ handler: (...args: unknown[]) => void; once: boolean }>
	> = new Map();

	constructor() {
		this.emitter = new EventEmitter();
	}

	/**
	 * Add an event listener.
	 */
	on<K extends keyof TEvents>(
		event: K,
		handler: EventHandler<TEvents[K]>,
	): this {
		const key = event as string;
		if (!this.handlers.has(key)) {
			this.handlers.set(key, new Set());
		}
		const handlers = this.handlers.get(key);
		if (handlers) {
			handlers.add({ handler: handler as () => void, once: false });
		}
		this.emitter.on(key, handler);
		return this;
	}

	/**
	 * Add a one-time event listener.
	 */
	once<K extends keyof TEvents>(
		event: K,
		handler: EventHandler<TEvents[K]>,
	): this {
		const key = event as string;
		if (!this.handlers.has(key)) {
			this.handlers.set(key, new Set());
		}
		const entry = { handler: handler as () => void, once: true };
		const handlers = this.handlers.get(key);
		if (handlers) {
			handlers.add(entry);
		}
		this.emitter.once(key, handler);
		return this;
	}

	/**
	 * Remove an event listener.
	 */
	off<K extends keyof TEvents>(
		event: K,
		handler: EventHandler<TEvents[K]>,
	): this {
		const key = event as string;
		const handlers = this.handlers.get(key);
		if (handlers) {
			for (const entry of handlers) {
				if (entry.handler === handler) {
					handlers.delete(entry);
					break;
				}
			}
		}
		this.emitter.off(key, handler);
		return this;
	}

	/**
	 * Emit an event.
	 */
	emit<K extends keyof TEvents>(
		event: K,
		...args: TEvents[K] extends undefined ? [] : [TEvents[K]]
	): boolean {
		const key = event as string;
		// Clean up once handlers from our tracking
		const handlers = this.handlers.get(key);
		if (handlers) {
			for (const entry of handlers) {
				if (entry.once) {
					handlers.delete(entry);
				}
			}
		}
		return this.emitter.emit(key, ...args);
	}

	/**
	 * Remove all listeners for an event, or all events.
	 */
	removeAllListeners<K extends keyof TEvents>(event?: K): this {
		if (event !== undefined) {
			const key = event as string;
			this.handlers.delete(key);
			this.emitter.removeAllListeners(key);
		} else {
			this.handlers.clear();
			this.emitter.removeAllListeners();
		}
		return this;
	}

	/**
	 * Get the number of listeners for an event.
	 */
	listenerCount<K extends keyof TEvents>(event: K): number {
		return this.emitter.listenerCount(event as string);
	}

	/**
	 * Get all event names that have listeners.
	 */
	eventNames(): Array<keyof TEvents> {
		return this.emitter.eventNames() as Array<keyof TEvents>;
	}

	/**
	 * Wait for an event to be emitted (returns a promise).
	 */
	waitFor<K extends keyof TEvents>(
		event: K,
		options?: { timeout?: number },
	): Promise<TEvents[K]> {
		return new Promise((resolve, reject) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const handler = ((data: TEvents[K]) => {
				if (timeoutId) clearTimeout(timeoutId);
				resolve(data);
			}) as EventHandler<TEvents[K]>;

			if (options?.timeout) {
				timeoutId = setTimeout(() => {
					this.off(event, handler);
					reject(new Error(`Timeout waiting for event: ${String(event)}`));
				}, options.timeout);
			}

			this.once(event, handler);
		});
	}

	/**
	 * Create a promise that resolves when any of the specified events is emitted.
	 */
	waitForAny<K extends keyof TEvents>(
		events: K[],
		options?: { timeout?: number },
	): Promise<{ event: K; data: TEvents[K] }> {
		return new Promise((resolve, reject) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			const handlers: Array<{ event: K; handler: EventHandler<TEvents[K]> }> =
				[];

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				for (const { event, handler } of handlers) {
					this.off(event, handler);
				}
			};

			for (const event of events) {
				const handler = ((data: TEvents[K]) => {
					cleanup();
					resolve({ event, data });
				}) as EventHandler<TEvents[K]>;
				handlers.push({ event, handler });
				this.once(event, handler);
			}

			if (options?.timeout) {
				timeoutId = setTimeout(() => {
					cleanup();
					reject(
						new Error(
							`Timeout waiting for events: ${events.map(String).join(", ")}`,
						),
					);
				}, options.timeout);
			}
		});
	}

	/**
	 * Pipe events from this emitter to another.
	 */
	pipe<K extends keyof TEvents>(
		event: K,
		target: TypedEmitter<TEvents>,
	): () => void {
		const handler = ((data: TEvents[K]) => {
			// Type assertion needed because TS can't infer conditional spread types
			const args = (
				data === undefined ? [] : [data]
			) as TEvents[K] extends undefined ? [] : [TEvents[K]];
			target.emit(event, ...args);
		}) as EventHandler<TEvents[K]>;
		this.on(event, handler);
		return () => this.off(event, handler);
	}
}

/**
 * Create a new typed event emitter.
 */
export function createTypedEmitter<
	TEvents extends Record<string, unknown>,
>(): TypedEmitter<TEvents> {
	return new TypedEmitter<TEvents>();
}

/**
 * Pre-defined events for Slack agent lifecycle.
 */
export interface SlackAgentEvents {
	/** Agent connected to Slack */
	connected: undefined;
	/** Agent disconnected from Slack */
	disconnected: { reason: string };
	/** Received a message */
	message: { text: string; channel: string; user: string; ts: string };
	/** Agent started processing */
	processing: { channel: string; thread_ts?: string };
	/** Agent finished processing */
	completed: { channel: string; thread_ts?: string; duration: number };
	/** Error occurred */
	error: { error: Error; context?: string };
	/** Rate limited */
	rateLimited: { method: string; retryAfter: number };
	/** Tool executed */
	toolExecuted: {
		tool: string;
		success: boolean;
		duration: number;
	};
}

/**
 * Create a typed emitter for Slack agent events.
 */
export function createSlackAgentEmitter(): TypedEmitter<SlackAgentEvents> {
	return new TypedEmitter<SlackAgentEvents>();
}
