/**
 * Real-Time User Input Channel
 *
 * Allows users to provide feedback, corrections, and guidance to autonomous agents
 * while they're running, without requiring a restart.
 *
 * ## Problem Solved
 *
 * Autonomous agents operate in "fire and forget" mode. Users have no way to:
 * - Correct misunderstood requirements
 * - Point out bugs the agent introduced
 * - Reprioritize work
 * - Provide clarification
 *
 * The only option was to kill and restart, losing context and progress.
 *
 * ## Solution: File-Based Message Queue
 *
 * ```
 * ~/.composer/sessions/<session-id>/
 * ├── inbox.json         # User writes messages here
 * └── outbox.json        # Agent writes acknowledgments here
 * ```
 *
 * ## Message Types
 *
 * | Type        | Description                              |
 * |-------------|------------------------------------------|
 * | feedback    | Correction or clarification              |
 * | reprioritize| Change task priority                     |
 * | pause       | Pause after current task                 |
 * | resume      | Continue after pause                     |
 * | skip        | Skip current task                        |
 * | context     | Additional context information           |
 * | abort       | Stop current task, mark incomplete       |
 *
 * ## Usage
 *
 * ```typescript
 * import { userInputChannel } from "./user-input-channel.js";
 *
 * // Initialize for a session
 * await userInputChannel.initialize(sessionId);
 *
 * // Check for messages (agent polling)
 * const messages = await userInputChannel.getMessages();
 * for (const msg of messages) {
 *   // Process message
 *   await userInputChannel.acknowledge(msg.id, "Understood, adjusting...");
 * }
 *
 * // Send a message (user/external process)
 * await userInputChannel.sendMessage({
 *   type: "feedback",
 *   content: "The search should be case-insensitive",
 *   priority: "high"
 * });
 * ```
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PATHS } from "../config/constants.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("agent:user-input-channel");

/**
 * Message types that users can send to the agent.
 */
export type UserMessageType =
	| "feedback"
	| "reprioritize"
	| "pause"
	| "resume"
	| "skip"
	| "context"
	| "abort";

/**
 * Priority levels for messages.
 */
export type MessagePriority = "low" | "normal" | "high" | "urgent";

/**
 * A message from the user to the agent.
 */
export interface UserInputMessage {
	/** Unique message ID */
	id: string;
	/** When the message was created */
	timestamp: string;
	/** Type of message */
	type: UserMessageType;
	/** Message content */
	content: string;
	/** Priority level */
	priority: MessagePriority;
	/** Optional feature/task ID to target */
	targetId?: string;
	/** Additional metadata */
	metadata?: Record<string, unknown>;
}

/**
 * Agent acknowledgment of a user message.
 */
export interface AgentAcknowledgment {
	/** ID of the message being acknowledged */
	messageId: string;
	/** When the acknowledgment was sent */
	timestamp: string;
	/** Acknowledgment text */
	response: string;
	/** Action taken */
	action: "processed" | "queued" | "ignored" | "error";
	/** Error details if action is "error" */
	error?: string;
}

/**
 * Inbox file structure.
 */
interface InboxFile {
	messages: UserInputMessage[];
	processed: string[]; // IDs of processed messages
}

/**
 * Outbox file structure.
 */
interface OutboxFile {
	acknowledgments: AgentAcknowledgment[];
}

/**
 * User input channel configuration.
 */
interface ChannelConfig {
	/** Directory for inbox/outbox files */
	channelDir: string;
	/** Polling interval in milliseconds */
	pollIntervalMs: number;
	/** Maximum messages to keep in history */
	maxHistorySize: number;
	/** Maximum age for messages before they're ignored (ms) */
	maxMessageAgeMs: number;
}

const DEFAULT_CONFIG: ChannelConfig = {
	channelDir: "",
	pollIntervalMs: 5000, // Check every 5 seconds
	maxHistorySize: 100,
	maxMessageAgeMs: 3600000, // 1 hour
};

/**
 * Generate a unique message ID.
 */
function generateMessageId(): string {
	return `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * User input channel manager.
 */
class UserInputChannel {
	private config: ChannelConfig = { ...DEFAULT_CONFIG };
	private sessionId: string | null = null;
	private initialized = false;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private listeners: Array<(messages: UserInputMessage[]) => void> = [];
	private isPaused = false;

	/**
	 * Initialize the channel for a session.
	 */
	async initialize(sessionId: string): Promise<void> {
		if (this.initialized && this.sessionId === sessionId) {
			return;
		}

		this.sessionId = sessionId;
		this.config.channelDir = join(
			PATHS.COMPOSER_HOME,
			"sessions",
			sessionId,
			"channel",
		);

		// Create channel directory
		if (!existsSync(this.config.channelDir)) {
			mkdirSync(this.config.channelDir, { recursive: true });
		}

		// Initialize inbox if it doesn't exist
		const inboxPath = this.getInboxPath();
		if (!existsSync(inboxPath)) {
			this.writeInbox({ messages: [], processed: [] });
		}

		// Initialize outbox if it doesn't exist
		const outboxPath = this.getOutboxPath();
		if (!existsSync(outboxPath)) {
			this.writeOutbox({ acknowledgments: [] });
		}

		this.initialized = true;
		logger.info("User input channel initialized", {
			sessionId,
			channelDir: this.config.channelDir,
		});
	}

	/**
	 * Start polling for messages.
	 */
	startPolling(onMessages?: (messages: UserInputMessage[]) => void): void {
		if (this.pollTimer) {
			return;
		}

		if (onMessages) {
			this.listeners.push(onMessages);
		}

		this.pollTimer = setInterval(async () => {
			try {
				const messages = await this.getMessages();
				if (messages.length > 0) {
					for (const listener of this.listeners) {
						try {
							listener(messages);
						} catch (error) {
							logger.warn("Message listener error", {
								error: error instanceof Error ? error.message : String(error),
							});
						}
					}
				}
			} catch (error) {
				logger.warn("Polling error", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}, this.config.pollIntervalMs);

		logger.info("Started polling for user input", {
			intervalMs: this.config.pollIntervalMs,
		});
	}

	/**
	 * Stop polling for messages.
	 */
	stopPolling(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
			this.listeners = [];
			logger.info("Stopped polling for user input");
		}
	}

	/**
	 * Get new messages from the inbox.
	 */
	async getMessages(): Promise<UserInputMessage[]> {
		if (!this.initialized) {
			return [];
		}

		const inbox = this.readInbox();
		const now = Date.now();
		const processedSet = new Set(inbox.processed);

		// Filter for new, unprocessed messages within age limit
		const newMessages = inbox.messages.filter((msg) => {
			if (processedSet.has(msg.id)) {
				return false;
			}
			const messageTime = new Date(msg.timestamp).getTime();
			if (now - messageTime > this.config.maxMessageAgeMs) {
				return false;
			}
			return true;
		});

		return newMessages;
	}

	/**
	 * Send a message (for use by external processes or CLI).
	 */
	async sendMessage(
		message: Omit<UserInputMessage, "id" | "timestamp">,
	): Promise<string> {
		if (!this.initialized) {
			throw new Error("Channel not initialized");
		}

		const fullMessage: UserInputMessage = {
			...message,
			id: generateMessageId(),
			timestamp: new Date().toISOString(),
		};

		const inbox = this.readInbox();
		inbox.messages.push(fullMessage);

		// Trim history
		if (inbox.messages.length > this.config.maxHistorySize) {
			inbox.messages = inbox.messages.slice(-this.config.maxHistorySize);
		}

		this.writeInbox(inbox);

		logger.info("User message sent", {
			messageId: fullMessage.id,
			type: fullMessage.type,
			priority: fullMessage.priority,
		});

		return fullMessage.id;
	}

	/**
	 * Acknowledge a message.
	 */
	async acknowledge(
		messageId: string,
		response: string,
		action: AgentAcknowledgment["action"] = "processed",
		error?: string,
	): Promise<void> {
		if (!this.initialized) {
			return;
		}

		// Mark as processed in inbox
		const inbox = this.readInbox();
		if (!inbox.processed.includes(messageId)) {
			inbox.processed.push(messageId);

			// Trim processed history
			if (inbox.processed.length > this.config.maxHistorySize * 2) {
				inbox.processed = inbox.processed.slice(-this.config.maxHistorySize);
			}

			this.writeInbox(inbox);
		}

		// Add acknowledgment to outbox
		const outbox = this.readOutbox();
		outbox.acknowledgments.push({
			messageId,
			timestamp: new Date().toISOString(),
			response,
			action,
			error,
		});

		// Trim acknowledgment history
		if (outbox.acknowledgments.length > this.config.maxHistorySize) {
			outbox.acknowledgments = outbox.acknowledgments.slice(
				-this.config.maxHistorySize,
			);
		}

		this.writeOutbox(outbox);

		logger.info("Message acknowledged", {
			messageId,
			action,
		});
	}

	/**
	 * Check if the agent is paused by user request.
	 */
	isPausedByUser(): boolean {
		return this.isPaused;
	}

	/**
	 * Process pause/resume messages.
	 */
	processPauseResume(message: UserInputMessage): boolean {
		if (message.type === "pause") {
			this.isPaused = true;
			logger.info("Agent paused by user request");
			return true;
		}
		if (message.type === "resume") {
			this.isPaused = false;
			logger.info("Agent resumed by user request");
			return true;
		}
		return false;
	}

	/**
	 * Get acknowledgments for a message.
	 */
	getAcknowledgment(messageId: string): AgentAcknowledgment | null {
		if (!this.initialized) {
			return null;
		}

		const outbox = this.readOutbox();
		return (
			outbox.acknowledgments.find((ack) => ack.messageId === messageId) ?? null
		);
	}

	/**
	 * Get the inbox file path.
	 */
	getInboxPath(): string {
		return join(this.config.channelDir, "inbox.json");
	}

	/**
	 * Get the outbox file path.
	 */
	getOutboxPath(): string {
		return join(this.config.channelDir, "outbox.json");
	}

	/**
	 * Read the inbox file.
	 */
	private readInbox(): InboxFile {
		try {
			const content = readFileSync(this.getInboxPath(), "utf-8");
			return JSON.parse(content) as InboxFile;
		} catch {
			return { messages: [], processed: [] };
		}
	}

	/**
	 * Write the inbox file.
	 */
	private writeInbox(inbox: InboxFile): void {
		writeFileSync(this.getInboxPath(), JSON.stringify(inbox, null, 2));
	}

	/**
	 * Read the outbox file.
	 */
	private readOutbox(): OutboxFile {
		try {
			const content = readFileSync(this.getOutboxPath(), "utf-8");
			return JSON.parse(content) as OutboxFile;
		} catch {
			return { acknowledgments: [] };
		}
	}

	/**
	 * Write the outbox file.
	 */
	private writeOutbox(outbox: OutboxFile): void {
		writeFileSync(this.getOutboxPath(), JSON.stringify(outbox, null, 2));
	}

	/**
	 * Clean up resources.
	 */
	cleanup(): void {
		this.stopPolling();
		this.initialized = false;
		this.sessionId = null;
	}
}

/**
 * Global user input channel instance.
 */
export const userInputChannel = new UserInputChannel();

/**
 * Convert a user input message to an agent message format.
 * For injection into the agent's conversation.
 */
export function formatUserInputForAgent(message: UserInputMessage): string {
	const priorityPrefix =
		message.priority === "urgent"
			? "[URGENT] "
			: message.priority === "high"
				? "[IMPORTANT] "
				: "";

	const typeLabel = {
		feedback: "User Feedback",
		reprioritize: "Priority Change Request",
		pause: "Pause Request",
		resume: "Resume Request",
		skip: "Skip Request",
		context: "Additional Context",
		abort: "Abort Request",
	}[message.type];

	let formatted = `[${typeLabel}] ${priorityPrefix}${message.content}`;

	if (message.targetId) {
		formatted += `\n(Target: ${message.targetId})`;
	}

	return formatted;
}

/**
 * Integration helper to process user input messages and convert to steering messages.
 *
 * @param sessionId - The session ID to monitor
 * @param onSteer - Callback to inject steering messages into the agent
 * @returns Cleanup function
 */
export function integrateUserInputChannel(
	sessionId: string,
	onSteer: (content: string, priority: MessagePriority) => Promise<void>,
): () => void {
	// Initialize channel
	userInputChannel.initialize(sessionId).catch((err) => {
		logger.warn("Failed to initialize user input channel", {
			error: err instanceof Error ? err.message : String(err),
		});
	});

	// Start polling and process messages
	userInputChannel.startPolling(async (messages) => {
		for (const msg of messages) {
			try {
				// Handle pause/resume
				if (userInputChannel.processPauseResume(msg)) {
					await userInputChannel.acknowledge(
						msg.id,
						msg.type === "pause"
							? "Agent paused. Send a resume message to continue."
							: "Agent resumed.",
						"processed",
					);
					continue;
				}

				// Convert to steering message and inject
				const formattedContent = formatUserInputForAgent(msg);
				await onSteer(formattedContent, msg.priority);

				// Acknowledge
				await userInputChannel.acknowledge(
					msg.id,
					"Message received and queued for processing.",
					"queued",
				);
			} catch (error) {
				await userInputChannel.acknowledge(
					msg.id,
					"Failed to process message",
					"error",
					error instanceof Error ? error.message : String(error),
				);
			}
		}
	});

	// Return cleanup function
	return () => {
		userInputChannel.cleanup();
	};
}
