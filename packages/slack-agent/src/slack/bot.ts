/**
 * Slack Bot - Socket Mode integration
 */

import { SocketModeClient } from "@slack/socket-mode";
import {
	type ChatPostMessageArguments,
	type ConversationsHistoryResponse,
	WebClient,
} from "@slack/web-api";
import { type IdempotencyConfig, IdempotencyManager } from "../idempotency.js";
import {
	type ValidationConfig,
	createValidator,
	sanitizeForLogging,
} from "../input-validation.js";
import * as logger from "../logger.js";
import { type Attachment, ChannelStore } from "../store.js";
import {
	type ApiQueue,
	type ApiQueueOptions,
	createApiQueue,
} from "../utils/api-queue.js";
import { type SlackMetrics, createSlackMetrics } from "../utils/metrics.js";
import { TtlCache } from "../utils/ttl-cache.js";
import { createResponseHandlers } from "./response-state.js";

export interface SlackMessage {
	text: string;
	rawText: string;
	user: string;
	userName?: string;
	channel: string;
	ts: string;
	threadTs?: string; // Parent thread timestamp (if this is a thread reply)
	attachments: Attachment[];
}

export interface SlackFile {
	id?: string;
	name?: string;
	url_private_download?: string;
	url_private?: string;
	mimetype?: string;
	filetype?: string;
	size?: number;
}

interface PreparedMessage {
	text: string;
	rawText: string;
	attachments: Attachment[];
	userName?: string;
	displayName?: string;
}

export interface SlackContext {
	message: SlackMessage;
	channelName?: string;
	store: ChannelStore;
	channels: ChannelInfo[];
	users: UserInfo[];
	/** Whether responses should go in a thread (true for channel mentions) */
	useThread: boolean;
	/** Per-run ID for observability (set by main.ts). */
	runId?: string;
	/** Scheduled task ID if this run is task-backed. */
	taskId?: string;
	/** Origin of the run (message, dm, slash, scheduled). */
	source?: "channel" | "dm" | "slash" | "scheduled";
	respond(text: string, log?: boolean): Promise<void>;
	replaceMessage(text: string): Promise<void>;
	respondInThread(text: string): Promise<void>;
	setTyping(isTyping: boolean): Promise<void>;
	uploadFile(filePath: string, title?: string): Promise<void>;
	setWorking(working: boolean): Promise<void>;
	/** Update status indicator (shows progress without creating new messages) */
	updateStatus(status: string): Promise<void>;
}

export interface ReactionContext {
	reaction: string;
	user: string;
	channel: string;
	messageTs: string;
	/** Add a reaction to a message */
	addReaction(emoji: string, channel: string, ts: string): Promise<void>;
	/** Post a message to the channel */
	postMessage(channel: string, text: string): Promise<void>;
}

export interface SlackAgentHandler {
	onChannelMention(ctx: SlackContext): Promise<void>;
	onDirectMessage(ctx: SlackContext): Promise<void>;
	onReaction?(ctx: ReactionContext): Promise<void>;
	onSlashCommand?(
		ctx: SlackContext,
		command: string,
		text: string,
	): Promise<void>;
}

export interface SlackBotConfig {
	appToken: string;
	botToken: string;
	workingDir: string;
	apiQueue?: ApiQueueOptions;
	idempotency?: IdempotencyConfig;
	metrics?: SlackMetrics;
	validation?: Partial<ValidationConfig>;
}

export interface ChannelInfo {
	id: string;
	name: string;
}

export interface UserInfo {
	id: string;
	userName: string;
	displayName: string;
}

export class SlackBot {
	private socketClient: SocketModeClient;
	private webClient: WebClient;
	private handler: SlackAgentHandler;
	private botUserId: string | null = null;
	public readonly store: ChannelStore;
	public readonly metrics: SlackMetrics;
	// Caches with 1-hour TTL to prevent unbounded memory growth
	private userCache = new TtlCache<
		string,
		{ userName: string; displayName: string }
	>({
		defaultTtlMs: 60 * 60 * 1000, // 1 hour
	});
	private channelCache = new TtlCache<string, string>({
		defaultTtlMs: 60 * 60 * 1000, // 1 hour
	});
	private recentEvents: Map<string, number> = new Map();
	private readonly eventDedupeMs = 5 * 60 * 1000;
	private lastEventCleanupMs = 0;
	private readonly eventCleanupIntervalMs = 60 * 1000;
	private readonly apiQueue: ApiQueue;
	private readonly idempotency: IdempotencyManager;
	private readonly validator: ReturnType<typeof createValidator>;

	constructor(handler: SlackAgentHandler, config: SlackBotConfig) {
		this.handler = handler;
		this.socketClient = new SocketModeClient({ appToken: config.appToken });
		this.webClient = new WebClient(config.botToken);
		this.store = new ChannelStore({
			workingDir: config.workingDir,
			botToken: config.botToken,
		});

		this.metrics = config.metrics ?? createSlackMetrics();
		this.validator = createValidator(config.validation);
		this.apiQueue = createApiQueue({
			...config.apiQueue,
			onRateLimit: (method, retryAfterSeconds) => {
				this.metrics.trackRateLimit(method);
				config.apiQueue?.onRateLimit?.(method, retryAfterSeconds);
			},
			onRetry: (method, attempt, delayMs, error) => {
				const errorType = error instanceof Error ? error.name : "unknown";
				this.metrics.trackError(method, errorType);
				config.apiQueue?.onRetry?.(method, attempt, delayMs, error);
			},
		});
		this.idempotency = new IdempotencyManager(
			config.workingDir,
			config.idempotency,
		);

		this.setupEventHandlers();
	}

	private async callSlack<T>(fn: () => Promise<T>, method: string): Promise<T> {
		return this.apiQueue.enqueue(method, () =>
			this.metrics.trackApiCall(method, fn),
		);
	}

	private async fetchChannels(): Promise<void> {
		try {
			let cursor: string | undefined;
			do {
				const result = await this.callSlack(
					() =>
						this.webClient.conversations.list({
							types: "public_channel,private_channel",
							exclude_archived: true,
							limit: 200,
							cursor,
						}),
					"conversations.list",
				);

				const channels = result.channels as
					| Array<{ id?: string; name?: string; is_member?: boolean }>
					| undefined;
				if (channels) {
					for (const channel of channels) {
						if (channel.id && channel.name && channel.is_member) {
							this.channelCache.set(channel.id, channel.name);
						}
					}
				}

				cursor = result.response_metadata?.next_cursor;
			} while (cursor);
		} catch (error) {
			logger.logWarning("Failed to fetch channels", String(error));
		}
	}

	private async fetchUsers(): Promise<void> {
		try {
			let cursor: string | undefined;
			do {
				const result = await this.callSlack(
					() =>
						this.webClient.users.list({
							limit: 200,
							cursor,
						}),
					"users.list",
				);

				const members = result.members as
					| Array<{
							id?: string;
							name?: string;
							real_name?: string;
							deleted?: boolean;
					  }>
					| undefined;
				if (members) {
					for (const user of members) {
						if (user.id && user.name && !user.deleted) {
							this.userCache.set(user.id, {
								userName: user.name,
								displayName: user.real_name || user.name,
							});
						}
					}
				}

				cursor = result.response_metadata?.next_cursor;
			} while (cursor);
		} catch (error) {
			logger.logWarning("Failed to fetch users", String(error));
		}
	}

	getChannels(): ChannelInfo[] {
		return Array.from(this.channelCache.entries()).map(([id, name]) => ({
			id,
			name,
		}));
	}

	getUsers(): UserInfo[] {
		return Array.from(this.userCache.entries()).map(
			([id, { userName, displayName }]) => ({
				id,
				userName,
				displayName,
			}),
		);
	}

	private obfuscateUsernames(text: string): string {
		let result = text;

		result = result.replace(/<@([A-Z0-9]+)>/gi, (_match, id) => {
			return `<@${id.split("").join("_")}>`;
		});

		for (const { userName } of this.userCache.values()) {
			const escaped = userName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const pattern = new RegExp(`(<@|@)?(\\b${escaped}\\b)`, "gi");
			result = result.replace(pattern, (_match, prefix, name) => {
				const obfuscated = name.split("").join("_");
				return (prefix || "") + obfuscated;
			});
		}
		return result;
	}

	private async getUserInfo(
		userId: string,
	): Promise<{ userName: string; displayName: string }> {
		const cached = this.userCache.get(userId);
		if (cached) {
			return cached;
		}

		try {
			const result = await this.callSlack(
				() => this.webClient.users.info({ user: userId }),
				"users.info",
			);
			const user = result.user as { name?: string; real_name?: string };
			const info = {
				userName: user?.name || userId,
				displayName: user?.real_name || user?.name || userId,
			};
			this.userCache.set(userId, info);
			return info;
		} catch {
			return { userName: userId, displayName: userId };
		}
	}

	private async shouldProcessEvent(
		key: string,
		eventId?: string,
	): Promise<boolean> {
		const now = Date.now();
		if (now - this.lastEventCleanupMs > this.eventCleanupIntervalMs) {
			const cutoff = now - this.eventDedupeMs;
			for (const [k, t] of this.recentEvents.entries()) {
				if (t < cutoff) this.recentEvents.delete(k);
			}
			this.lastEventCleanupMs = now;
		}

		if (eventId) {
			const check = await this.idempotency.checkAndLock(eventId, key);
			if (!check.shouldProcess) {
				return false;
			}
		} else if (this.recentEvents.has(key)) {
			return false;
		}

		this.recentEvents.set(key, now);
		return true;
	}

	private async processEvent(
		key: string,
		eventId: string | undefined,
		handler: () => Promise<void>,
	): Promise<void> {
		if (!(await this.shouldProcessEvent(key, eventId))) return;

		try {
			await handler();
			if (eventId) {
				try {
					await this.idempotency.markComplete(eventId);
				} catch (markError) {
					const details =
						markError instanceof Error ? markError.message : String(markError);
					logger.logWarning("Failed to record idempotency completion", details);
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.logWarning("Slack event handler failed", message);
			if (eventId) {
				try {
					await this.idempotency.markFailed(eventId, message);
				} catch (markError) {
					const details =
						markError instanceof Error ? markError.message : String(markError);
					logger.logWarning("Failed to record idempotency failure", details);
				}
			}
		}
	}

	private setupEventHandlers(): void {
		this.socketClient.on("app_mention", async ({ event, ack, body }) => {
			await ack();

			const envelope = body as { event_id?: string };
			const slackEvent = event as {
				text: string;
				channel: string;
				user: string;
				ts: string;
				thread_ts?: string; // Present if mention is in a thread
				files?: SlackFile[];
			};

			const dedupeKey = `app_mention:${slackEvent.channel}:${slackEvent.ts}`;
			await this.processEvent(dedupeKey, envelope.event_id, async () => {
				const prepared = await this.logMessage({
					text: slackEvent.text,
					channel: slackEvent.channel,
					user: slackEvent.user,
					ts: slackEvent.ts,
					threadTs: slackEvent.thread_ts,
					files: slackEvent.files,
				});

				// For channel mentions, always use thread mode
				// Use existing thread if mentioned in a thread, otherwise create new thread
				const ctx = await this.createContext(
					slackEvent,
					{ useThread: true },
					prepared,
				);
				await this.handler.onChannelMention(ctx);
			});
		});

		// Handle real Slack slash commands via Socket Mode (envelope type: slash_commands)
		this.socketClient.on(
			"slash_commands",
			async ({ body, ack, envelope_id }) => {
				await ack();

				if (!this.handler.onSlashCommand) return;

				const slackCommand = body as {
					command: string;
					text?: string;
					channel_id: string;
					user_id: string;
					trigger_id?: string;
					response_url?: string;
					event_id?: string;
				};

				if (
					!slackCommand.command ||
					!slackCommand.channel_id ||
					!slackCommand.user_id
				) {
					return;
				}

				const key = `slash:${slackCommand.channel_id}:${
					slackCommand.trigger_id || envelope_id
				}`;
				const eventId = slackCommand.event_id ?? slackCommand.trigger_id;
				await this.processEvent(key, eventId, async () => {
					const ctx = await this.createSlashContext(slackCommand);
					await this.handler.onSlashCommand(
						ctx,
						slackCommand.command,
						slackCommand.text || "",
					);
				});
			},
		);

		this.socketClient.on("message", async ({ event, ack, body }) => {
			await ack();

			const envelope = body as { event_id?: string };
			const slackEvent = event as {
				text?: string;
				channel: string;
				user?: string;
				ts: string;
				thread_ts?: string; // Present if this is a thread reply
				channel_type?: string;
				subtype?: string;
				bot_id?: string;
				files?: SlackFile[];
			};

			if (slackEvent.bot_id) return;
			if (
				slackEvent.subtype !== undefined &&
				slackEvent.subtype !== "file_share"
			)
				return;
			if (!slackEvent.user) return;
			if (slackEvent.user === this.botUserId) return;
			if (
				!slackEvent.text &&
				(!slackEvent.files || slackEvent.files.length === 0)
			)
				return;

			const dedupeKey = `message:${slackEvent.channel}:${slackEvent.ts}`;
			await this.processEvent(dedupeKey, envelope.event_id, async () => {
				const prepared = await this.logMessage({
					text: slackEvent.text || "",
					channel: slackEvent.channel,
					user: slackEvent.user,
					ts: slackEvent.ts,
					threadTs: slackEvent.thread_ts,
					files: slackEvent.files,
				});

				if (slackEvent.channel_type === "im") {
					// DMs don't use thread mode by default (more conversational)
					const ctx = await this.createContext(
						{
							text: slackEvent.text || "",
							channel: slackEvent.channel,
							user: slackEvent.user,
							ts: slackEvent.ts,
							thread_ts: slackEvent.thread_ts,
							files: slackEvent.files,
						},
						{ useThread: false },
						prepared,
					);
					await this.handler.onDirectMessage(ctx);
				}
			});
		});

		// Handle reaction events
		this.socketClient.on("reaction_added", async ({ event, ack, body }) => {
			await ack();

			if (!this.handler.onReaction) return;

			const envelope = body as { event_id?: string };
			const reactionEvent = event as {
				reaction: string;
				user: string;
				item: {
					type: string;
					channel: string;
					ts: string;
				};
			};

			// Only handle reactions to messages
			if (reactionEvent.item.type !== "message") return;

			// Ignore bot's own reactions
			if (reactionEvent.user === this.botUserId) return;

			const dedupeKey = `reaction:${reactionEvent.item.channel}:${reactionEvent.item.ts}:${reactionEvent.reaction}:${reactionEvent.user}`;
			await this.processEvent(dedupeKey, envelope.event_id, async () => {
				await this.handler.onReaction({
					reaction: reactionEvent.reaction,
					user: reactionEvent.user,
					channel: reactionEvent.item.channel,
					messageTs: reactionEvent.item.ts,
					addReaction: async (emoji: string, channel: string, ts: string) => {
						try {
							await this.callSlack(
								() =>
									this.webClient.reactions.add({
										name: emoji,
										channel,
										timestamp: ts,
									}),
								"reactions.add",
							);
						} catch {
							// Ignore errors (e.g., already reacted)
						}
					},
					postMessage: async (channel: string, text: string) => {
						await this.callSlack(
							() => this.webClient.chat.postMessage({ channel, text }),
							"chat.postMessage",
						);
					},
				});
			});
		});
	}

	private truncateRawText(text: string): string {
		const raw = text ?? "";
		const maxLen = this.validator.config.maxMessageLength;
		if (raw.length > maxLen) {
			logger.logWarning(
				"Message truncated",
				sanitizeForLogging(
					`Truncated from ${raw.length} to ${maxLen} characters`,
				),
			);
			return raw.slice(0, maxLen);
		}
		return raw;
	}

	private normalizeText(
		rawText: string,
		hasAttachments: boolean,
	): { text: string; rawText: string } {
		const truncatedRaw = this.truncateRawText(rawText);
		const cleaned = truncatedRaw.replace(/<@[A-Z0-9]+>/gi, "").trim();
		if (!cleaned) {
			if (!hasAttachments) {
				logger.logWarning(
					"Empty message text",
					sanitizeForLogging(truncatedRaw),
				);
			}
			return { text: "", rawText: truncatedRaw };
		}

		const validation = this.validator.validateMessage(cleaned);
		if (!validation.valid) {
			logger.logWarning(
				"Invalid message text",
				sanitizeForLogging(validation.error ?? "Invalid message"),
			);
			return { text: cleaned, rawText: truncatedRaw };
		}
		if (validation.truncatedText) {
			logger.logWarning(
				"Message truncated",
				sanitizeForLogging(validation.error ?? "Message truncated"),
			);
			return { text: validation.truncatedText, rawText: truncatedRaw };
		}
		return { text: cleaned, rawText: truncatedRaw };
	}

	private filterFiles(files: SlackFile[]): SlackFile[] {
		const { maxAttachments, maxFileSize } = this.validator.config;
		let filtered = files;
		if (files.length > maxAttachments) {
			logger.logWarning(
				"Too many attachments",
				`Received ${files.length} (max ${maxAttachments}); keeping first ${maxAttachments}`,
			);
			filtered = files.slice(0, maxAttachments);
		}

		const oversized = filtered.filter(
			(file) => file.size && file.size > maxFileSize,
		);
		if (oversized.length > 0) {
			const names = oversized
				.map((file) => file.name ?? file.id ?? "file")
				.join(", ");
			logger.logWarning(
				"Skipping oversized attachments",
				sanitizeForLogging(names),
			);
			filtered = filtered.filter(
				(file) => !(file.size && file.size > maxFileSize),
			);
		}

		return filtered;
	}

	private async resolveFiles(files: SlackFile[]): Promise<SlackFile[]> {
		const resolved: SlackFile[] = [];
		for (const file of files) {
			if (file.url_private_download || file.url_private || !file.id) {
				resolved.push(file);
				continue;
			}

			try {
				const result = await this.callSlack(
					() => this.webClient.files.info({ file: file.id }),
					"files.info",
				);
				const info = result.file as SlackFile | undefined;
				resolved.push(info ? { ...file, ...info } : file);
			} catch (error) {
				logger.logWarning(
					"Failed to fetch file info",
					sanitizeForLogging(String(error)),
				);
				resolved.push(file);
			}
		}

		return resolved;
	}

	private async buildAttachments(
		channelId: string,
		files: SlackFile[] | undefined,
		ts: string,
	): Promise<Attachment[]> {
		if (!files || files.length === 0) return [];
		const filtered = this.filterFiles(files);
		if (filtered.length === 0) return [];
		const resolved = await this.resolveFiles(filtered);
		return this.store.processAttachments(channelId, resolved, ts);
	}

	private async prepareMessage(event: {
		text?: string;
		channel: string;
		user: string;
		ts: string;
		threadTs?: string;
		files?: SlackFile[];
	}): Promise<PreparedMessage> {
		const attachments = await this.buildAttachments(
			event.channel,
			event.files,
			event.ts,
		);
		const { text, rawText } = this.normalizeText(
			event.text ?? "",
			attachments.length > 0,
		);
		const { userName, displayName } = await this.getUserInfo(event.user);
		return { text, rawText, attachments, userName, displayName };
	}

	private async logMessage(event: {
		text: string;
		channel: string;
		user: string;
		ts: string;
		threadTs?: string;
		files?: SlackFile[];
	}): Promise<PreparedMessage> {
		const prepared = await this.prepareMessage(event);

		await this.store.logMessage(event.channel, {
			date: new Date(Number.parseFloat(event.ts) * 1000).toISOString(),
			ts: event.ts,
			threadTs: event.threadTs,
			user: event.user,
			userName: prepared.userName,
			displayName: prepared.displayName,
			text: prepared.rawText,
			attachments: prepared.attachments,
			isBot: false,
		});
		return prepared;
	}

	private async createContext(
		event: {
			text: string;
			channel: string;
			user: string;
			ts: string;
			thread_ts?: string;
			files?: SlackFile[];
		},
		options: { useThread: boolean } = { useThread: false },
		prepared?: PreparedMessage,
	): Promise<SlackContext> {
		const preparedMessage = prepared ?? (await this.prepareMessage(event));
		const { text, rawText, attachments } = preparedMessage;
		const userName =
			preparedMessage.userName ?? (await this.getUserInfo(event.user)).userName;

		let channelName: string | undefined;
		try {
			if (event.channel.startsWith("C")) {
				const result = await this.callSlack(
					() =>
						this.webClient.conversations.info({
							channel: event.channel,
						}),
					"conversations.info",
				);
				channelName = result.channel?.name
					? `#${result.channel.name}`
					: undefined;
			}
		} catch {
			// Ignore
		}

		// Determine the thread to use for responses:
		// - If user message is in a thread, reply in that thread
		// - If useThread is true (channel mentions), use the user's message as thread parent
		// - Otherwise (DMs), post directly to channel
		const useThread = options.useThread;
		const parentThreadTs = event.thread_ts; // Existing thread the user messaged in
		const userMessageTs = event.ts; // The user's message timestamp
		const threadTs = parentThreadTs || (useThread ? userMessageTs : undefined);

		const responseHandlers = createResponseHandlers({
			channelId: event.channel,
			webClient: this.webClient,
			store: this.store,
			callSlack: this.callSlack.bind(this),
			obfuscateUsernames: this.obfuscateUsernames.bind(this),
			threadTs,
			// Also post to channel when starting a new thread (not replying to existing)
			replyBroadcast: threadTs ? useThread && !parentThreadTs : undefined,
		});

		return {
			message: {
				text,
				rawText,
				user: event.user,
				userName,
				channel: event.channel,
				ts: event.ts,
				threadTs: event.thread_ts,
				attachments,
			},
			channelName,
			store: this.store,
			channels: this.getChannels(),
			users: this.getUsers(),
			useThread,
			...responseHandlers,
		};
	}

	private async backfillChannel(channelId: string): Promise<number> {
		const lastTs = this.store.getLastTimestamp(channelId);

		type Message = NonNullable<
			ConversationsHistoryResponse["messages"]
		>[number];
		const allMessages: Message[] = [];

		let cursor: string | undefined;
		let pageCount = 0;
		const maxPages = 3;

		do {
			const result = await this.callSlack(
				() =>
					this.webClient.conversations.history({
						channel: channelId,
						oldest: lastTs ?? undefined,
						inclusive: false,
						limit: 1000,
						cursor,
					}),
				"conversations.history",
			);

			if (result.messages) {
				allMessages.push(...result.messages);
			}

			cursor = result.response_metadata?.next_cursor;
			pageCount++;
		} while (cursor && pageCount < maxPages);

		const relevantMessages = allMessages.filter((msg) => {
			if (msg.user === this.botUserId) return true;
			if (msg.bot_id) return false;
			if (msg.subtype !== undefined && msg.subtype !== "file_share")
				return false;
			if (!msg.user) return false;
			if (!msg.text && (!msg.files || msg.files.length === 0)) return false;
			return true;
		});

		relevantMessages.reverse();

		for (const msg of relevantMessages) {
			const msgTs = msg.ts || "";
			const isBotMessage = msg.user === this.botUserId;
			const attachments = msg.files
				? await this.buildAttachments(
						channelId,
						msg.files as SlackFile[],
						msgTs,
					)
				: [];
			const rawText = this.truncateRawText(msg.text || "");

			if (isBotMessage) {
				await this.store.logMessage(channelId, {
					date: new Date(Number.parseFloat(msgTs) * 1000).toISOString(),
					ts: msgTs,
					user: "bot",
					text: rawText,
					attachments,
					isBot: true,
				});
			} else {
				const { userName, displayName } = await this.getUserInfo(
					msg.user || "",
				);
				await this.store.logMessage(channelId, {
					date: new Date(Number.parseFloat(msgTs) * 1000).toISOString(),
					ts: msgTs,
					user: msg.user || "",
					userName,
					displayName,
					text: rawText,
					attachments,
					isBot: false,
				});
			}
		}

		return relevantMessages.length;
	}

	private async backfillAllChannels(): Promise<void> {
		const startTime = Date.now();
		logger.logBackfillStart(this.channelCache.size);

		let totalMessages = 0;

		for (const [channelId, channelName] of this.channelCache) {
			try {
				const count = await this.backfillChannel(channelId);
				if (count > 0) {
					logger.logBackfillChannel(channelName, count);
				}
				totalMessages += count;
			} catch (error) {
				logger.logWarning(
					`Failed to backfill channel #${channelName}`,
					String(error),
				);
			}
		}

		const durationMs = Date.now() - startTime;
		logger.logBackfillComplete(totalMessages, durationMs);
	}

	async start(): Promise<void> {
		const auth = await this.callSlack(
			() => this.webClient.auth.test(),
			"auth.test",
		);
		this.botUserId = auth.user_id as string;

		await Promise.all([this.fetchChannels(), this.fetchUsers()]);
		logger.logInfo(
			`Loaded ${this.channelCache.size} channels, ${this.userCache.size} users`,
		);

		await this.backfillAllChannels();

		await this.socketClient.start();
		logger.logConnected();
	}

	async stop(): Promise<void> {
		await this.socketClient.disconnect();
		logger.logDisconnected();
	}

	/**
	 * Post a message to a channel (for scheduled tasks, notifications, etc.)
	 */
	async postMessage(channelId: string, text: string): Promise<string | null> {
		try {
			const result = await this.callSlack(
				() =>
					this.webClient.chat.postMessage({
						channel: channelId,
						text,
					}),
				"chat.postMessage",
			);
			return result.ts as string;
		} catch (error) {
			logger.logWarning(
				`Failed to post message to ${channelId}`,
				String(error),
			);
			return null;
		}
	}

	/**
	 * Create a context for a Slack slash command.
	 * Slash commands arrive via Socket Mode as "slash_commands" envelopes.
	 */
	async createSlashContext(command: {
		command: string;
		text?: string;
		channel_id: string;
		user_id: string;
	}): Promise<SlackContext> {
		const now = Date.now();
		const ts = `${Math.floor(now / 1000)}.${(now % 1000) * 1000}`;

		const rawText = this.truncateRawText(
			`${command.command} ${command.text || ""}`.trim(),
		);
		const { userName } = await this.getUserInfo(command.user_id);

		const responseHandlers = createResponseHandlers({
			channelId: command.channel_id,
			webClient: this.webClient,
			store: this.store,
			callSlack: this.callSlack.bind(this),
			obfuscateUsernames: this.obfuscateUsernames.bind(this),
		});

		return {
			message: {
				text: rawText,
				rawText,
				user: command.user_id,
				userName,
				channel: command.channel_id,
				ts,
				attachments: [],
			},
			channelName: this.channelCache.get(command.channel_id),
			store: this.store,
			channels: this.getChannels(),
			users: this.getUsers(),
			useThread: false,
			source: "slash",
			...responseHandlers,
		};
	}

	/**
	 * Create a context for scheduled tasks (no user message to respond to)
	 */
	async createScheduledContext(
		channelId: string,
		prompt: string,
	): Promise<SlackContext> {
		const now = Date.now();
		const ts = `${Math.floor(now / 1000)}.${(now % 1000) * 1000}`;

		const responseHandlers = createResponseHandlers({
			channelId,
			webClient: this.webClient,
			store: this.store,
			callSlack: this.callSlack.bind(this),
			obfuscateUsernames: this.obfuscateUsernames.bind(this),
		});

		const safePrompt = this.truncateRawText(prompt);
		return {
			message: {
				text: safePrompt,
				rawText: safePrompt,
				user: "scheduled",
				userName: "Scheduled Task",
				channel: channelId,
				ts,
				attachments: [],
			},
			channelName: this.channelCache.get(channelId),
			store: this.store,
			channels: this.getChannels(),
			users: this.getUsers(),
			useThread: false,
			...responseHandlers,
		};
	}
}
