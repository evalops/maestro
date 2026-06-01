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
	/** Replace the primary visible response, when the surface supports it. */
	replaceMessage?(text: string, log?: boolean, logText?: string): Promise<void>;
	/** Send a message to a thread */
	respondInThread(text: string, log?: boolean): Promise<void>;
	/** Send a standalone message to an explicit Slack channel. */
	postMessage?(channel: string, text: string, log?: boolean): Promise<void>;
	/** Send a standalone reply to an explicit Slack thread. */
	postThreadReply?(
		channel: string,
		threadTs: string,
		text: string,
		log?: boolean,
	): Promise<void>;
	/** Update an existing processing/status surface without adding a new reply. */
	updateStatus?(status: string): Promise<void>;
}

export type MessageDeliveryKind =
	| "message"
	| "thread_reply"
	| "progress"
	| "final"
	| "final_continuation"
	| "error"
	| "blocker"
	| "request"
	| "delivery_error";

export type MessageDeliveryTarget = "main" | "thread" | "status";

export interface MessageDeliveryEvent {
	kind: MessageDeliveryKind;
	target: MessageDeliveryTarget;
	textLength: number;
	chunkIndex?: number;
	chunkCount?: number;
}

export interface MessageQueueOptions {
	/** Handler for sending messages */
	handler: MessageHandler;
	/** Function to split long text into chunks (optional) */
	splitText?: (text: string) => string[];
	/** Error callback (defaults to logger.logWarning) */
	onError?: (context: string, error: string) => void;
	/** Called after a Slack-visible delivery succeeds. The event excludes text. */
	onDelivery?: (event: MessageDeliveryEvent) => void;
	/** Minimum delay between visible progress updates. */
	progressMinIntervalMs?: number;
	/** Maximum progress status length before truncation. */
	progressMaxLength?: number;
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
	private onDelivery?: (event: MessageDeliveryEvent) => void;
	private progressMinIntervalMs: number;
	private progressMaxLength: number;
	private lastProgressAt = 0;
	private finalQueued = false;
	private finalPending = false;
	private queuedFinalText = "";
	private deliveryFailureCount = 0;
	private lastDeliveryFailure:
		| {
				context: string;
				error: string;
		  }
		| undefined;

	constructor(options: MessageQueueOptions) {
		this.handler = options.handler;
		this.splitText = options.splitText ?? ((text) => [text]);
		this.onDelivery = options.onDelivery;
		this.progressMinIntervalMs = Math.max(
			0,
			options.progressMinIntervalMs ?? 15000,
		);
		this.progressMaxLength = Math.max(40, options.progressMaxLength ?? 220);
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
				this.deliveryFailureCount += 1;
				this.lastDeliveryFailure = { context: errorContext, error: errMsg };
				this.onError(errorContext, errMsg);
				try {
					await this.handler.respondInThread(
						`_I hit a Slack delivery error: ${errMsg}_`,
					);
					this.notifyDelivery({
						kind: "delivery_error",
						target: "thread",
						textLength: errMsg.length,
					});
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
		kind: MessageDeliveryKind = target === "main" ? "message" : "thread_reply",
	): void {
		const parts = this.splitText(text);
		const chunkCount = parts.length;
		for (const [index, part] of parts.entries()) {
			this.enqueue(async () => {
				if (target === "main") {
					await this.handler.respond(part, log);
				} else {
					await this.handler.respondInThread(part);
				}
				this.notifyDelivery({
					kind,
					target,
					textLength: part.length,
					chunkIndex: index,
					chunkCount,
				});
			}, errorContext);
		}
	}

	/**
	 * Queue a normal channel message. The channel argument is part of the teammate
	 * delivery contract; the bound Slack handler already owns the concrete channel.
	 */
	sendMessage(channel: string, text: string, log = true): void {
		const postMessage = this.handler.postMessage;
		if (!postMessage) {
			throw new Error(
				"send_message requires explicit Slack postMessage support",
			);
		}
		const parts = this.splitText(text);
		const chunkCount = parts.length;
		for (const [index, part] of parts.entries()) {
			this.enqueue(async () => {
				await postMessage(channel, part, log);
				this.notifyDelivery({
					kind: "message",
					target: "main",
					textLength: part.length,
					chunkIndex: index,
					chunkCount,
				});
			}, "send_message");
		}
	}

	/**
	 * Queue a thread reply. Long text is split into ordered continuation replies.
	 */
	sendThreadReply(
		channel: string,
		threadTs: string,
		text: string,
		log = false,
	): void {
		const postThreadReply = this.handler.postThreadReply;
		if (!postThreadReply) {
			throw new Error(
				"send_thread_reply requires explicit Slack postThreadReply support",
			);
		}
		const parts = this.splitText(text);
		const chunkCount = parts.length;
		for (const [index, part] of parts.entries()) {
			this.enqueue(async () => {
				await postThreadReply(channel, threadTs, part, log);
				this.notifyDelivery({
					kind: "thread_reply",
					target: "thread",
					textLength: part.length,
					chunkIndex: index,
					chunkCount,
				});
			}, "send_thread_reply");
		}
	}

	/**
	 * Queue a short progress update if the progress rate limit allows it.
	 * Progress is deliberately status-like: one line, short, and best effort.
	 */
	sendProgress(text: string): boolean {
		const progress = this.progressText(text);
		if (!progress) return false;
		const now = Date.now();
		if (
			this.lastProgressAt > 0 &&
			now - this.lastProgressAt < this.progressMinIntervalMs
		) {
			return false;
		}
		this.lastProgressAt = now;
		this.enqueue(
			() =>
				this.handler.updateStatus
					? this.handler.updateStatus(progress).then(() =>
							this.notifyDelivery({
								kind: "progress",
								target: "status",
								textLength: progress.length,
							}),
						)
					: this.handler.respond(`_${progress}_`, false).then(() =>
							this.notifyDelivery({
								kind: "progress",
								target: "main",
								textLength: progress.length,
							}),
						),
			"send_progress",
		);
		return true;
	}

	/**
	 * Queue the one primary final answer. The first chunk replaces the working
	 * message; overflow continues in the thread automatically.
	 */
	sendFinal(text: string): boolean {
		const finalText = text.trim();
		if (!finalText || this.finalQueued || this.finalPending) return false;
		const parts = this.splitText(finalText);
		if (parts.length === 0) return false;
		this.finalPending = true;
		const first = parts[0]!;
		this.enqueue(async () => {
			try {
				if (this.handler.replaceMessage) {
					await this.handler.replaceMessage(first, true, finalText);
				} else {
					await this.handler.respond(first, true);
				}
				this.notifyDelivery({
					kind: "final",
					target: "main",
					textLength: first.length,
					chunkIndex: 0,
					chunkCount: parts.length,
				});
				for (const [index, part] of parts.slice(1).entries()) {
					await this.handler.respondInThread(part);
					this.notifyDelivery({
						kind: "final_continuation",
						target: "thread",
						textLength: part.length,
						chunkIndex: index + 1,
						chunkCount: parts.length,
					});
				}
				this.finalQueued = true;
				this.queuedFinalText = finalText;
			} finally {
				this.finalPending = false;
			}
		}, "send_final");
		return true;
	}

	hasFinal(): boolean {
		return this.finalQueued;
	}

	finalText(): string {
		return this.queuedFinalText;
	}

	/**
	 * Queue a visible blocker/error reply separate from the final answer.
	 */
	sendError(text: string): void {
		const message = this.progressText(text);
		if (!message) return;
		this.enqueue(async () => {
			await this.handler.respondInThread(`_I hit an error: ${message}_`, true);
			this.notifyDelivery({
				kind: "error",
				target: "thread",
				textLength: message.length,
			});
		}, "send_error");
	}

	/**
	 * Queue a visible blocker reply separate from the final answer.
	 */
	sendBlocker(text: string): void {
		const message = this.progressText(text);
		if (!message) return;
		this.enqueue(async () => {
			await this.handler.respondInThread(`_I'm blocked: ${message}_`, true);
			this.notifyDelivery({
				kind: "blocker",
				target: "thread",
				textLength: message.length,
			});
		}, "send_blocker");
	}

	/**
	 * Queue a concrete user request or approval prompt in the thread.
	 */
	sendRequest(text: string): void {
		const message = this.progressText(text);
		if (!message) return;
		this.enqueue(async () => {
			await this.handler.respondInThread(`_I need: ${message}_`, true);
			this.notifyDelivery({
				kind: "request",
				target: "thread",
				textLength: message.length,
			});
		}, "send_request");
	}

	/**
	 * Wait for all queued operations to complete.
	 */
	flush(): Promise<void> {
		return this.chain;
	}

	deliveryFailures(): number {
		return this.deliveryFailureCount;
	}

	async flushOrThrowIfDeliveryFailed(
		previousFailureCount: number,
	): Promise<void> {
		await this.flush();
		if (this.deliveryFailureCount <= previousFailureCount) return;
		const context = this.lastDeliveryFailure?.context ?? "Slack delivery";
		throw new Error(`${context} failed to deliver in Slack.`);
	}

	private progressText(text: string): string {
		let normalized = text.replace(/\s+/g, " ").trim();
		if (!normalized) return "";
		if (normalized.length > this.progressMaxLength) {
			normalized = `${normalized.slice(0, this.progressMaxLength - 3).trimEnd()}...`;
		}
		return normalized;
	}

	private notifyDelivery(event: MessageDeliveryEvent): void {
		try {
			this.onDelivery?.(event);
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			this.onError("delivery event", errMsg);
		}
	}
}
