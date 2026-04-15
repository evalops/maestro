/**
 * MessageQueue - Promise-based sequential message delivery
 *
 * Ensures messages are delivered in order by chaining promises.
 * Failed deliveries are caught and logged, allowing the queue to continue.
 */

import * as logger from "../logger.js";

export interface MessageHandler {
	/** Send a message to the main channel */
	respond(text: string, log?: boolean): Promise<void>;
	/** Send a message to a thread */
	respondInThread(text: string): Promise<void>;
}

export interface MessageQueueOptions {
	/** Handler for sending messages */
	handler: MessageHandler;
	/** Function to split long text into chunks (optional) */
	splitText?: (text: string) => string[];
	/** Error callback (defaults to logger.logWarning) */
	onError?: (context: string, error: string) => void;
}

/**
 * Sequential message queue that maintains delivery order.
 * Messages are enqueued and delivered one at a time, ensuring
 * responses arrive in the correct sequence.
 */
export class MessageQueue {
	private chain: Promise<void> = Promise.resolve();
	private handler: MessageHandler;
	private splitText: (text: string) => string[];
	private onError: (context: string, error: string) => void;

	constructor(options: MessageQueueOptions) {
		this.handler = options.handler;
		this.splitText = options.splitText ?? ((text) => [text]);
		this.onError =
			options.onError ??
			((context, error) => {
				logger.logWarning(`Slack API error (${context})`, error);
			});
	}

	/**
	 * Enqueue an async operation for sequential execution.
	 * Errors are caught and logged, then the queue continues.
	 */
	enqueue(fn: () => Promise<void>, errorContext: string): void {
		this.chain = this.chain.then(async () => {
			try {
				await fn();
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				this.onError(errorContext, errMsg);
				try {
					await this.handler.respondInThread(`_Error: ${errMsg}_`);
				} catch {
					// Ignore nested errors
				}
			}
		});
	}

	/**
	 * Enqueue a text message to be sent to main channel or thread.
	 * Long messages are automatically split using the splitText function.
	 */
	enqueueMessage(
		text: string,
		target: "main" | "thread",
		errorContext: string,
		log = true,
	): void {
		const parts = this.splitText(text);
		for (const part of parts) {
			this.enqueue(
				() =>
					target === "main"
						? this.handler.respond(part, log)
						: this.handler.respondInThread(part),
				errorContext,
			);
		}
	}

	/**
	 * Wait for all queued operations to complete.
	 */
	flush(): Promise<void> {
		return this.chain;
	}
}
