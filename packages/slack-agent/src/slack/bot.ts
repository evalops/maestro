/**
 * Slack Bot - Socket Mode integration
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { SocketModeClient } from "@slack/socket-mode";
import {
	type ChatPostMessageArguments,
	type ConversationsHistoryResponse,
	type FilesUploadV2Arguments,
	WebClient,
} from "@slack/web-api";
import * as logger from "../logger.js";
import { type Attachment, ChannelStore } from "../store.js";

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

export interface SlackContext {
	message: SlackMessage;
	channelName?: string;
	store: ChannelStore;
	channels: ChannelInfo[];
	users: UserInfo[];
	/** Whether responses should go in a thread (true for channel mentions) */
	useThread: boolean;
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
}

export interface SlackBotConfig {
	appToken: string;
	botToken: string;
	workingDir: string;
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
	private userCache: Map<string, { userName: string; displayName: string }> =
		new Map();
	private channelCache: Map<string, string> = new Map();

	constructor(handler: SlackAgentHandler, config: SlackBotConfig) {
		this.handler = handler;
		this.socketClient = new SocketModeClient({ appToken: config.appToken });
		this.webClient = new WebClient(config.botToken);
		this.store = new ChannelStore({
			workingDir: config.workingDir,
			botToken: config.botToken,
		});

		this.setupEventHandlers();
	}

	private async fetchChannels(): Promise<void> {
		try {
			let cursor: string | undefined;
			do {
				const result = await this.webClient.conversations.list({
					types: "public_channel,private_channel",
					exclude_archived: true,
					limit: 200,
					cursor,
				});

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
				const result = await this.webClient.users.list({
					limit: 200,
					cursor,
				});

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
			const result = await this.webClient.users.info({ user: userId });
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

	private setupEventHandlers(): void {
		this.socketClient.on("app_mention", async ({ event, ack }) => {
			await ack();

			const slackEvent = event as {
				text: string;
				channel: string;
				user: string;
				ts: string;
				thread_ts?: string; // Present if mention is in a thread
				files?: Array<{
					name: string;
					url_private_download?: string;
					url_private?: string;
					mimetype?: string;
					filetype?: string;
					size?: number;
				}>;
			};

			await this.logMessage({
				text: slackEvent.text,
				channel: slackEvent.channel,
				user: slackEvent.user,
				ts: slackEvent.ts,
				threadTs: slackEvent.thread_ts,
				files: slackEvent.files,
			});

			// For channel mentions, always use thread mode
			// Use existing thread if mentioned in a thread, otherwise create new thread
			const ctx = await this.createContext(slackEvent, { useThread: true });
			await this.handler.onChannelMention(ctx);
		});

		this.socketClient.on("message", async ({ event, ack }) => {
			await ack();

			const slackEvent = event as {
				text?: string;
				channel: string;
				user?: string;
				ts: string;
				thread_ts?: string; // Present if this is a thread reply
				channel_type?: string;
				subtype?: string;
				bot_id?: string;
				files?: Array<{
					name: string;
					url_private_download?: string;
					url_private?: string;
					mimetype?: string;
					filetype?: string;
					size?: number;
				}>;
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

			await this.logMessage({
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
				);
				await this.handler.onDirectMessage(ctx);
			}
		});

		// Handle reaction events
		this.socketClient.on("reaction_added", async ({ event, ack }) => {
			await ack();

			if (!this.handler.onReaction) return;

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

			await this.handler.onReaction({
				reaction: reactionEvent.reaction,
				user: reactionEvent.user,
				channel: reactionEvent.item.channel,
				messageTs: reactionEvent.item.ts,
				addReaction: async (emoji: string, channel: string, ts: string) => {
					try {
						await this.webClient.reactions.add({
							name: emoji,
							channel,
							timestamp: ts,
						});
					} catch {
						// Ignore errors (e.g., already reacted)
					}
				},
				postMessage: async (channel: string, text: string) => {
					await this.webClient.chat.postMessage({ channel, text });
				},
			});
		});
	}

	private async logMessage(event: {
		text: string;
		channel: string;
		user: string;
		ts: string;
		threadTs?: string;
		files?: Array<{
			name: string;
			url_private_download?: string;
			url_private?: string;
			mimetype?: string;
			filetype?: string;
			size?: number;
		}>;
	}): Promise<void> {
		const attachments = event.files
			? this.store.processAttachments(event.channel, event.files, event.ts)
			: [];
		const { userName, displayName } = await this.getUserInfo(event.user);

		await this.store.logMessage(event.channel, {
			date: new Date(Number.parseFloat(event.ts) * 1000).toISOString(),
			ts: event.ts,
			threadTs: event.threadTs,
			user: event.user,
			userName,
			displayName,
			text: event.text,
			attachments,
			isBot: false,
		});
	}

	private async createContext(
		event: {
			text: string;
			channel: string;
			user: string;
			ts: string;
			thread_ts?: string;
			files?: Array<{
				name: string;
				url_private_download?: string;
				url_private?: string;
				mimetype?: string;
				filetype?: string;
				size?: number;
			}>;
		},
		options: { useThread: boolean } = { useThread: false },
	): Promise<SlackContext> {
		const rawText = event.text;
		const text = rawText.replace(/<@[A-Z0-9]+>/gi, "").trim();

		const { userName } = await this.getUserInfo(event.user);

		let channelName: string | undefined;
		try {
			if (event.channel.startsWith("C")) {
				const result = await this.webClient.conversations.info({
					channel: event.channel,
				});
				channelName = result.channel?.name
					? `#${result.channel.name}`
					: undefined;
			}
		} catch {
			// Ignore
		}

		const attachments = event.files
			? this.store.processAttachments(event.channel, event.files, event.ts)
			: [];

		// Determine the thread to use for responses:
		// - If user message is in a thread, reply in that thread
		// - If useThread is true (channel mentions), use the user's message as thread parent
		// - Otherwise (DMs), post directly to channel
		const useThread = options.useThread;
		const parentThreadTs = event.thread_ts; // Existing thread the user messaged in
		const userMessageTs = event.ts; // The user's message timestamp

		let messageTs: string | null = null;
		let accumulatedText = "";
		let isThinking = true;
		let isWorking = true;
		const workingIndicator = " ...";
		let updatePromise: Promise<void> = Promise.resolve();

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
			respond: async (responseText: string, log = true) => {
				updatePromise = updatePromise.then(async () => {
					if (isThinking) {
						accumulatedText = responseText;
						isThinking = false;
					} else {
						accumulatedText += `\n${responseText}`;
					}

					const displayText = isWorking
						? accumulatedText + workingIndicator
						: accumulatedText;

					// Determine thread_ts for the response:
					// - If user is in a thread, reply in that thread
					// - If useThread mode, reply as thread to user's message
					// - Otherwise post to channel directly
					const threadTs =
						parentThreadTs || (useThread ? userMessageTs : undefined);

					if (messageTs) {
						await this.webClient.chat.update({
							channel: event.channel,
							ts: messageTs,
							text: displayText,
						});
					} else {
						const postArgs = {
							channel: event.channel,
							text: displayText,
							thread_ts: threadTs,
							// Also post to channel when starting a new thread (not replying to existing)
							reply_broadcast: threadTs
								? useThread && !parentThreadTs
								: undefined,
						} as ChatPostMessageArguments;
						const result = await this.webClient.chat.postMessage(postArgs);
						messageTs = result.ts as string;
					}

					if (log && messageTs) {
						await this.store.logBotResponse(
							event.channel,
							responseText,
							messageTs,
						);
					}
				});

				await updatePromise;
			},
			respondInThread: async (threadText: string) => {
				updatePromise = updatePromise.then(async () => {
					if (!messageTs) {
						return;
					}
					const obfuscatedText = this.obfuscateUsernames(threadText);
					await this.webClient.chat.postMessage({
						channel: event.channel,
						thread_ts: messageTs,
						text: obfuscatedText,
					});
				});
				await updatePromise;
			},
			setTyping: async (typing: boolean) => {
				if (typing && !messageTs) {
					accumulatedText = "_Thinking_";
					const threadTs =
						parentThreadTs || (useThread ? userMessageTs : undefined);
					const postArgs = {
						channel: event.channel,
						text: accumulatedText,
						thread_ts: threadTs,
						reply_broadcast: threadTs
							? useThread && !parentThreadTs
							: undefined,
					} as ChatPostMessageArguments;
					const result = await this.webClient.chat.postMessage(postArgs);
					messageTs = result.ts as string;
				}
			},
			uploadFile: async (filePath: string, title?: string) => {
				const fileName = title || basename(filePath);
				const fileContent = readFileSync(filePath);
				const threadTs =
					parentThreadTs || (useThread ? userMessageTs : undefined);

				const uploadArgs = {
					channel_id: event.channel,
					file: fileContent,
					filename: fileName,
					title: fileName,
					...(threadTs && { thread_ts: threadTs }),
				} as FilesUploadV2Arguments;
				await this.webClient.files.uploadV2(uploadArgs);
			},
			replaceMessage: async (newText: string) => {
				updatePromise = updatePromise.then(async () => {
					accumulatedText = newText;

					const displayText = isWorking
						? accumulatedText + workingIndicator
						: accumulatedText;

					const threadTs =
						parentThreadTs || (useThread ? userMessageTs : undefined);

					if (messageTs) {
						await this.webClient.chat.update({
							channel: event.channel,
							ts: messageTs,
							text: displayText,
						});
					} else {
						const postArgs = {
							channel: event.channel,
							text: displayText,
							thread_ts: threadTs,
							reply_broadcast: threadTs
								? useThread && !parentThreadTs
								: undefined,
						} as ChatPostMessageArguments;
						const result = await this.webClient.chat.postMessage(postArgs);
						messageTs = result.ts as string;
					}
				});
				await updatePromise;
			},
			setWorking: async (working: boolean) => {
				updatePromise = updatePromise.then(async () => {
					isWorking = working;

					if (messageTs) {
						const displayText = isWorking
							? accumulatedText + workingIndicator
							: accumulatedText;
						await this.webClient.chat.update({
							channel: event.channel,
							ts: messageTs,
							text: displayText,
						});
					}
				});
				await updatePromise;
			},
			updateStatus: async (status: string) => {
				updatePromise = updatePromise.then(async () => {
					if (messageTs && isWorking) {
						// Update the working indicator with the status
						const displayText = `${accumulatedText}\n_${status}_${workingIndicator}`;
						await this.webClient.chat.update({
							channel: event.channel,
							ts: messageTs,
							text: displayText,
						});
					}
				});
				await updatePromise;
			},
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
			const result = await this.webClient.conversations.history({
				channel: channelId,
				oldest: lastTs ?? undefined,
				inclusive: false,
				limit: 1000,
				cursor,
			});

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
				? this.store.processAttachments(channelId, msg.files, msgTs)
				: [];

			if (isBotMessage) {
				await this.store.logMessage(channelId, {
					date: new Date(Number.parseFloat(msgTs) * 1000).toISOString(),
					ts: msgTs,
					user: "bot",
					text: msg.text || "",
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
					text: msg.text || "",
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
		const auth = await this.webClient.auth.test();
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
			const result = await this.webClient.chat.postMessage({
				channel: channelId,
				text,
			});
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
	 * Create a context for scheduled tasks (no user message to respond to)
	 */
	async createScheduledContext(
		channelId: string,
		prompt: string,
	): Promise<SlackContext> {
		const now = Date.now();
		const ts = `${Math.floor(now / 1000)}.${(now % 1000) * 1000}`;

		let messageTs: string | null = null;
		let accumulatedText = "";
		let isThinking = true;
		let isWorking = true;
		const workingIndicator = " ...";
		let updatePromise: Promise<void> = Promise.resolve();

		return {
			message: {
				text: prompt,
				rawText: prompt,
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
			respond: async (responseText: string, log = true) => {
				updatePromise = updatePromise.then(async () => {
					if (isThinking) {
						accumulatedText = responseText;
						isThinking = false;
					} else {
						accumulatedText += `\n${responseText}`;
					}

					const displayText = isWorking
						? accumulatedText + workingIndicator
						: accumulatedText;

					if (messageTs) {
						await this.webClient.chat.update({
							channel: channelId,
							ts: messageTs,
							text: displayText,
						});
					} else {
						const result = await this.webClient.chat.postMessage({
							channel: channelId,
							text: displayText,
						});
						messageTs = result.ts as string;
					}

					if (log && messageTs) {
						await this.store.logBotResponse(channelId, responseText, messageTs);
					}
				});
				await updatePromise;
			},
			respondInThread: async (threadText: string) => {
				updatePromise = updatePromise.then(async () => {
					if (!messageTs) return;
					const obfuscatedText = this.obfuscateUsernames(threadText);
					await this.webClient.chat.postMessage({
						channel: channelId,
						thread_ts: messageTs,
						text: obfuscatedText,
					});
				});
				await updatePromise;
			},
			setTyping: async (typing: boolean) => {
				if (typing && !messageTs) {
					accumulatedText = "_Thinking_";
					const result = await this.webClient.chat.postMessage({
						channel: channelId,
						text: accumulatedText,
					});
					messageTs = result.ts as string;
				}
			},
			uploadFile: async (filePath: string, title?: string) => {
				const fileName = title || basename(filePath);
				const fileContent = readFileSync(filePath);
				await this.webClient.files.uploadV2({
					channel_id: channelId,
					file: fileContent,
					filename: fileName,
					title: fileName,
				});
			},
			replaceMessage: async (newText: string) => {
				updatePromise = updatePromise.then(async () => {
					accumulatedText = newText;
					const displayText = isWorking
						? accumulatedText + workingIndicator
						: accumulatedText;

					if (messageTs) {
						await this.webClient.chat.update({
							channel: channelId,
							ts: messageTs,
							text: displayText,
						});
					} else {
						const result = await this.webClient.chat.postMessage({
							channel: channelId,
							text: displayText,
						});
						messageTs = result.ts as string;
					}
				});
				await updatePromise;
			},
			setWorking: async (working: boolean) => {
				updatePromise = updatePromise.then(async () => {
					isWorking = working;
					if (messageTs) {
						const displayText = isWorking
							? accumulatedText + workingIndicator
							: accumulatedText;
						await this.webClient.chat.update({
							channel: channelId,
							ts: messageTs,
							text: displayText,
						});
					}
				});
				await updatePromise;
			},
			updateStatus: async (status: string) => {
				updatePromise = updatePromise.then(async () => {
					if (messageTs && isWorking) {
						const displayText = `${accumulatedText}\n_${status}_${workingIndicator}`;
						await this.webClient.chat.update({
							channel: channelId,
							ts: messageTs,
							text: displayText,
						});
					}
				});
				await updatePromise;
			},
		};
	}
}
