/**
 * Slack Bot - Socket Mode integration
 */

import { join } from "node:path";
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
	type ThreadMemoryConfig,
	ThreadMemoryManager,
} from "../thread-memory.js";
import {
	type ApiQueue,
	type ApiQueueOptions,
	createApiQueue,
} from "../utils/api-queue.js";
import { type SlackMetrics, createSlackMetrics } from "../utils/metrics.js";
import { PersistentTtlCache } from "../utils/persistent-ttl-cache.js";
import { createResponseHandlers } from "./response-state.js";

export interface SlackMessage {
	text: string;
	rawText: string;
	user: string;
	userName?: string;
	teamId: string;
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
	teamId: string;
	channelName?: string;
	store: ChannelStore;
	channels: ChannelInfo[];
	users: UserInfo[];
	/** Thread identifier for per-thread memory (channel ID for DMs) */
	threadKey: string;
	/** Whether responses should go in a thread (true for channel mentions) */
	useThread: boolean;
	/** Per-run ID for observability (set by main.ts). */
	runId?: string;
	/** Scheduled task ID if this run is task-backed. */
	taskId?: string;
	/** Origin of the run (message, dm, slash, scheduled). */
	source?: "channel" | "dm" | "slash" | "scheduled" | "trigger";
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
	teamId: string;
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
	/** Single-workspace bot token. For multi-workspace, use resolveWorkspace instead. */
	botToken?: string;
	workingDir: string;
	/** Default team ID to use when events do not include a team_id (rare). */
	defaultTeamId?: string;
	/**
	 * Multi-workspace resolver. Given a Slack team ID, return the bot token + per-workspace
	 * workingDir (used for persistence: logs, permissions, connectors, dashboards, etc).
	 */
	resolveWorkspace?: (
		teamId: string,
	) => { botToken: string; workingDir: string } | null;
	/**
	 * If set, only process events for this Slack workspace/team ID.
	 *
	 * Note: Socket Mode may distribute events across multiple active connections. This
	 * option is best used for debugging, not sharding.
	 */
	allowedTeamId?: string;
	apiQueue?: ApiQueueOptions;
	idempotency?: IdempotencyConfig;
	metrics?: SlackMetrics;
	validation?: Partial<ValidationConfig>;
	/** Optional cache directory for persistent caches */
	cacheDir?: string;
	/** Thread memory configuration (per-thread context) */
	threadMemory?: ThreadMemoryConfig;
	/** Max messages per conversations.history request */
	historyLimit?: number;
	/** Max pages to backfill per channel */
	historyMaxPages?: number;
	/** Number of concurrent channel backfills */
	backfillConcurrency?: number;
	/** Toggle backfill on startup */
	backfillOnStartup?: boolean;
	/** Only backfill matching channel IDs or names */
	backfillInclude?: string[];
	/** Skip backfill for matching channel IDs or names */
	backfillExclude?: string[];
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

type WorkspaceState = {
	teamId: string;
	botToken: string;
	workingDir: string;
	webClient: WebClient;
	store: ChannelStore;
	threadMemory: ThreadMemoryManager;
	userCache: PersistentTtlCache<
		string,
		{ userName: string; displayName: string }
	>;
	channelCache: PersistentTtlCache<string, string>;
	apiQueue: ApiQueue;
	idempotency: IdempotencyManager;
	botUserId: string | null;
	/** Ensures we only perform heavyweight warmup once per workspace. */
	warmupPromise: Promise<void> | null;
};

export class SlackBot {
	private socketClient: SocketModeClient;
	private handler: SlackAgentHandler;

	/**
	 * Legacy single-workspace store accessor. For multi-workspace, prefer ctx.store.
	 * This is kept to avoid breaking single-workspace usage patterns.
	 */
	public readonly store: ChannelStore;
	public readonly metrics: SlackMetrics;

	private readonly workspaces = new Map<string, WorkspaceState>();
	private readonly workspaceResolver: (
		teamId: string,
	) => { botToken: string; workingDir: string } | null;
	private readonly defaultTeamId: string;

	private recentEvents: Map<string, number> = new Map();
	private readonly eventDedupeMs = 5 * 60 * 1000;
	private lastEventCleanupMs = 0;
	private readonly eventCleanupIntervalMs = 60 * 1000;
	private readonly validator: ReturnType<typeof createValidator>;
	private readonly historyLimit: number;
	private readonly historyMaxPages: number;
	private readonly backfillConcurrency: number;
	private readonly backfillOnStartup: boolean;
	private readonly backfillInclude: Set<string> | null;
	private readonly backfillExclude: Set<string>;
	private readonly allowedTeamId: string | null;
	private readonly cacheDirBase: string | undefined;
	private readonly apiQueueOptions: ApiQueueOptions | undefined;
	private readonly idempotencyOptions: IdempotencyConfig | undefined;
	private readonly threadMemoryOptions: ThreadMemoryConfig | undefined;
	private readonly multiWorkspace: boolean;

	constructor(handler: SlackAgentHandler, config: SlackBotConfig) {
		this.handler = handler;
		this.socketClient = new SocketModeClient({ appToken: config.appToken });

		this.metrics = config.metrics ?? createSlackMetrics();
		this.validator = createValidator(config.validation);
		this.historyLimit = Math.max(1, Math.min(config.historyLimit ?? 15, 1000));
		this.historyMaxPages = Math.max(1, config.historyMaxPages ?? 3);
		this.backfillConcurrency = Math.max(1, config.backfillConcurrency ?? 1);
		this.backfillOnStartup = config.backfillOnStartup ?? true;
		const include = this.normalizeBackfillSelectors(config.backfillInclude);
		this.backfillInclude = include.size > 0 ? include : null;
		this.backfillExclude = this.normalizeBackfillSelectors(
			config.backfillExclude,
		);
		this.allowedTeamId = config.allowedTeamId ?? null;

		this.defaultTeamId =
			config.defaultTeamId ?? config.allowedTeamId ?? "default";
		this.cacheDirBase = config.cacheDir;
		this.apiQueueOptions = config.apiQueue;
		this.idempotencyOptions = config.idempotency;
		this.threadMemoryOptions = config.threadMemory;

		this.multiWorkspace = !!config.resolveWorkspace;

		if (config.resolveWorkspace) {
			this.workspaceResolver = config.resolveWorkspace;
		} else if (config.botToken) {
			this.workspaceResolver = () => ({
				botToken: config.botToken as string,
				workingDir: config.workingDir,
			});
		} else {
			throw new Error(
				"SlackBot requires botToken (single workspace) or resolveWorkspace (multi-workspace)",
			);
		}

		// Legacy default store (single-workspace usage). In multi-workspace mode this may be unused.
		this.store = new ChannelStore({
			workingDir: config.workingDir,
			botToken: config.botToken ?? "",
		});

		this.setupEventHandlers();
	}

	private async callSlack<T>(
		ws: WorkspaceState,
		fn: () => Promise<T>,
		method: string,
	): Promise<T> {
		return ws.apiQueue.enqueue(method, () =>
			this.metrics.trackApiCall(method, fn),
		);
	}

	private async getWorkspaceState(
		teamId: string | undefined,
	): Promise<WorkspaceState | null> {
		const resolvedTeamId = teamId || this.defaultTeamId;
		if (!resolvedTeamId) return null;

		const cached = this.workspaces.get(resolvedTeamId);
		if (cached) return cached;

		const resolved = this.workspaceResolver(resolvedTeamId);
		if (!resolved) return null;

		const cacheDir = this.cacheDirBase
			? join(this.cacheDirBase, resolvedTeamId)
			: join(resolved.workingDir, "cache");

		const apiQueue = createApiQueue({
			...this.apiQueueOptions,
			onRateLimit: (method, retryAfterSeconds) => {
				this.metrics.trackRateLimit(method);
				this.apiQueueOptions?.onRateLimit?.(method, retryAfterSeconds);
			},
			onRetry: (method, attempt, delayMs, error) => {
				const errorType = error instanceof Error ? error.name : "unknown";
				this.metrics.trackError(method, errorType);
				this.apiQueueOptions?.onRetry?.(method, attempt, delayMs, error);
			},
		});

		const ws: WorkspaceState = {
			teamId: resolvedTeamId,
			botToken: resolved.botToken,
			workingDir: resolved.workingDir,
			webClient: new WebClient(resolved.botToken),
			store: new ChannelStore({
				workingDir: resolved.workingDir,
				botToken: resolved.botToken,
			}),
			threadMemory: new ThreadMemoryManager(
				resolved.workingDir,
				this.threadMemoryOptions,
			),
			userCache: new PersistentTtlCache({
				persistPath: join(cacheDir, "users.json"),
				defaultTtlMs: 60 * 60 * 1000, // 1 hour
				persistIntervalMs: 30 * 1000,
			}),
			channelCache: new PersistentTtlCache({
				persistPath: join(cacheDir, "channels.json"),
				defaultTtlMs: 60 * 60 * 1000, // 1 hour
				persistIntervalMs: 30 * 1000,
			}),
			apiQueue,
			idempotency: new IdempotencyManager(
				resolved.workingDir,
				this.idempotencyOptions,
			),
			botUserId: null,
			warmupPromise: null,
		};

		this.workspaces.set(resolvedTeamId, ws);
		return ws;
	}

	private async ensureBotUserId(ws: WorkspaceState): Promise<void> {
		if (ws.botUserId) return;
		try {
			const auth = await this.callSlack(
				ws,
				() => ws.webClient.auth.test(),
				"auth.test",
			);
			ws.botUserId = (auth as { user_id?: string }).user_id ?? null;
		} catch (error) {
			logger.logWarning(
				`Failed to auth.test for workspace ${ws.teamId}`,
				String(error),
			);
		}
	}

	private async fetchChannels(ws: WorkspaceState): Promise<void> {
		try {
			let cursor: string | undefined;
			do {
				const result = await this.callSlack(
					ws,
					() =>
						ws.webClient.conversations.list({
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
							ws.channelCache.set(channel.id, channel.name);
						}
					}
				}

				cursor = result.response_metadata?.next_cursor;
			} while (cursor);
		} catch (error) {
			logger.logWarning("Failed to fetch channels", String(error));
		}
	}

	private async fetchUsers(ws: WorkspaceState): Promise<void> {
		try {
			let cursor: string | undefined;
			do {
				const result = await this.callSlack(
					ws,
					() =>
						ws.webClient.users.list({
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
							ws.userCache.set(user.id, {
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

	private getChannels(ws: WorkspaceState): ChannelInfo[] {
		return Array.from(ws.channelCache.entries()).map(([id, name]) => ({
			id,
			name,
		}));
	}

	private getUsers(ws: WorkspaceState): UserInfo[] {
		return Array.from(ws.userCache.entries()).map(
			([id, { userName, displayName }]) => ({
				id,
				userName,
				displayName,
			}),
		);
	}

	private obfuscateUsernames(ws: WorkspaceState, text: string): string {
		let result = text;

		result = result.replace(/<@([A-Z0-9]+)>/gi, (_match, id) => {
			return `<@${id.split("").join("_")}>`;
		});

		for (const { userName } of ws.userCache.values()) {
			const escaped = userName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const pattern = new RegExp(`(<@|@)?(\\b${escaped}\\b)`, "gi");
			result = result.replace(pattern, (_match, prefix, name) => {
				const obfuscated = name.split("").join("_");
				return (prefix || "") + obfuscated;
			});
		}
		return result;
	}

	private normalizeBackfillSelector(value: string): string {
		return value.trim().toLowerCase().replace(/^#/, "");
	}

	private normalizeBackfillSelectors(values?: string[]): Set<string> {
		if (!values) return new Set();
		return new Set(
			values
				.map((value) => this.normalizeBackfillSelector(value))
				.filter((value) => value.length > 0),
		);
	}

	private shouldBackfillChannel(
		channelId: string,
		channelName: string,
	): boolean {
		const normalizedId = this.normalizeBackfillSelector(channelId);
		const normalizedName = this.normalizeBackfillSelector(channelName);
		const isIncluded = this.backfillInclude
			? this.backfillInclude.has(normalizedId) ||
				this.backfillInclude.has(normalizedName)
			: true;
		if (!isIncluded) return false;
		if (
			this.backfillExclude.has(normalizedId) ||
			this.backfillExclude.has(normalizedName)
		) {
			return false;
		}
		return true;
	}

	private async getUserInfo(
		ws: WorkspaceState,
		userId: string,
	): Promise<{ userName: string; displayName: string }> {
		const cached = ws.userCache.get(userId);
		if (cached) {
			return cached;
		}

		try {
			const result = await this.callSlack(
				ws,
				() => ws.webClient.users.info({ user: userId }),
				"users.info",
			);
			const user = result.user as { name?: string; real_name?: string };
			const info = {
				userName: user?.name || userId,
				displayName: user?.real_name || user?.name || userId,
			};
			ws.userCache.set(userId, info);
			return info;
		} catch {
			return { userName: userId, displayName: userId };
		}
	}

	private async shouldProcessEvent(
		ws: WorkspaceState,
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
			const check = await ws.idempotency.checkAndLock(eventId, key);
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
		ws: WorkspaceState,
		key: string,
		eventId: string | undefined,
		handler: () => Promise<void>,
	): Promise<void> {
		if (!(await this.shouldProcessEvent(ws, key, eventId))) return;

		try {
			await handler();
			if (eventId) {
				try {
					await ws.idempotency.markComplete(eventId);
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
					await ws.idempotency.markFailed(eventId, message);
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

			const envelope = body as { event_id?: string; team_id?: string };
			if (
				this.allowedTeamId &&
				envelope.team_id &&
				envelope.team_id !== this.allowedTeamId
			) {
				return;
			}
			const ws = await this.getWorkspaceState(envelope.team_id);
			if (!ws) return;
			const slackEvent = event as {
				text: string;
				channel: string;
				user: string;
				ts: string;
				thread_ts?: string; // Present if mention is in a thread
				files?: SlackFile[];
			};

			const dedupeKey = `app_mention:${ws.teamId}:${slackEvent.channel}:${slackEvent.ts}`;
			await this.processEvent(ws, dedupeKey, envelope.event_id, async () => {
				const prepared = await this.logMessage(ws, {
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
					ws,
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

				const onSlashCommand = this.handler.onSlashCommand;
				if (!onSlashCommand) return;

				const slackCommand = body as {
					command: string;
					text?: string;
					channel_id: string;
					user_id: string;
					team_id?: string;
					trigger_id?: string;
					response_url?: string;
					event_id?: string;
				};

				if (
					this.allowedTeamId &&
					slackCommand.team_id &&
					slackCommand.team_id !== this.allowedTeamId
				) {
					return;
				}
				const ws = await this.getWorkspaceState(slackCommand.team_id);
				if (!ws) return;

				if (
					!slackCommand.command ||
					!slackCommand.channel_id ||
					!slackCommand.user_id
				) {
					return;
				}

				const eventId = slackCommand.event_id ?? slackCommand.trigger_id;
				const keyed = `slash:${ws.teamId}:${slackCommand.channel_id}:${
					slackCommand.trigger_id || envelope_id
				}`;
				await this.processEvent(ws, keyed, eventId, async () => {
					const ctx = await this.createSlashContextTeam(
						ws.teamId,
						slackCommand,
					);
					await onSlashCommand(
						ctx,
						slackCommand.command,
						slackCommand.text || "",
					);
				});
			},
		);

		this.socketClient.on("message", async ({ event, ack, body }) => {
			await ack();

			const envelope = body as { event_id?: string; team_id?: string };
			if (
				this.allowedTeamId &&
				envelope.team_id &&
				envelope.team_id !== this.allowedTeamId
			) {
				return;
			}
			const ws = await this.getWorkspaceState(envelope.team_id);
			if (!ws) return;
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
				message?: {
					ts?: string;
					text?: string;
					user?: string;
					thread_ts?: string;
				};
				previous_message?: { ts?: string; user?: string };
				deleted_ts?: string;
			};

			if (slackEvent.bot_id) return;
			if (slackEvent.subtype === "message_changed") {
				await this.handleMessageChanged(ws, slackEvent);
				return;
			}
			if (slackEvent.subtype === "message_deleted") {
				await this.handleMessageDeleted(ws, slackEvent);
				return;
			}
			if (
				slackEvent.subtype !== undefined &&
				slackEvent.subtype !== "file_share"
			)
				return;
			const user = slackEvent.user;
			if (!user) return;
			if (ws.botUserId && user === ws.botUserId) return;
			if (
				!slackEvent.text &&
				(!slackEvent.files || slackEvent.files.length === 0)
			)
				return;

			const dedupeKey = `message:${ws.teamId}:${slackEvent.channel}:${slackEvent.ts}`;
			await this.processEvent(ws, dedupeKey, envelope.event_id, async () => {
				const prepared = await this.logMessage(ws, {
					text: slackEvent.text || "",
					channel: slackEvent.channel,
					user,
					ts: slackEvent.ts,
					threadTs: slackEvent.thread_ts,
					files: slackEvent.files,
				});

				if (slackEvent.channel_type === "im") {
					// DMs don't use thread mode by default (more conversational)
					const ctx = await this.createContext(
						ws,
						{
							text: slackEvent.text || "",
							channel: slackEvent.channel,
							user,
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

			const onReaction = this.handler.onReaction;
			if (!onReaction) return;

			const envelope = body as { event_id?: string; team_id?: string };
			if (
				this.allowedTeamId &&
				envelope.team_id &&
				envelope.team_id !== this.allowedTeamId
			) {
				return;
			}
			const ws = await this.getWorkspaceState(envelope.team_id);
			if (!ws) return;
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
			if (ws.botUserId && reactionEvent.user === ws.botUserId) return;

			const dedupeKey = `reaction:${ws.teamId}:${reactionEvent.item.channel}:${reactionEvent.item.ts}:${reactionEvent.reaction}:${reactionEvent.user}`;
			await this.processEvent(ws, dedupeKey, envelope.event_id, async () => {
				await onReaction({
					reaction: reactionEvent.reaction,
					user: reactionEvent.user,
					teamId: ws.teamId,
					channel: reactionEvent.item.channel,
					messageTs: reactionEvent.item.ts,
					addReaction: async (emoji: string, channel: string, ts: string) => {
						try {
							await this.callSlack(
								ws,
								() =>
									ws.webClient.reactions.add({
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
							ws,
							() => ws.webClient.chat.postMessage({ channel, text }),
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

	private async resolveFiles(
		ws: WorkspaceState,
		files: SlackFile[],
	): Promise<SlackFile[]> {
		const resolved: SlackFile[] = [];
		for (const file of files) {
			const fileId = file.id;
			if (file.url_private_download || file.url_private || !fileId) {
				resolved.push(file);
				continue;
			}

			try {
				const result = await this.callSlack(
					ws,
					() => ws.webClient.files.info({ file: fileId }),
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
		ws: WorkspaceState,
		channelId: string,
		files: SlackFile[] | undefined,
		ts: string,
	): Promise<Attachment[]> {
		if (!files || files.length === 0) return [];
		const filtered = this.filterFiles(files);
		if (filtered.length === 0) return [];
		const resolved = await this.resolveFiles(ws, filtered);
		return ws.store.processAttachments(channelId, resolved, ts);
	}

	private async prepareMessage(
		ws: WorkspaceState,
		event: {
			text?: string;
			channel: string;
			user: string;
			ts: string;
			threadTs?: string;
			files?: SlackFile[];
		},
	): Promise<PreparedMessage> {
		const attachments = await this.buildAttachments(
			ws,
			event.channel,
			event.files,
			event.ts,
		);
		const { text, rawText } = this.normalizeText(
			event.text ?? "",
			attachments.length > 0,
		);
		const { userName, displayName } = await this.getUserInfo(ws, event.user);
		return { text, rawText, attachments, userName, displayName };
	}

	private async logMessage(
		ws: WorkspaceState,
		event: {
			text: string;
			channel: string;
			user: string;
			ts: string;
			threadTs?: string;
			files?: SlackFile[];
		},
	): Promise<PreparedMessage> {
		const prepared = await this.prepareMessage(ws, event);

		await ws.store.logMessage(event.channel, {
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

		const threadKey = this.getThreadKey(
			event.channel,
			event.ts,
			event.threadTs,
		);
		try {
			await ws.threadMemory.addMessage(event.channel, threadKey, {
				role: "user",
				content: prepared.rawText,
				userId: event.user,
				messageTs: event.ts,
				metadata: {
					userName: prepared.userName,
					displayName: prepared.displayName,
					attachments: prepared.attachments.map((a) => a.local),
				},
			});
		} catch (error) {
			logger.logWarning(
				"Failed to append user message to thread memory",
				String(error),
			);
		}
		return prepared;
	}

	private async handleMessageChanged(
		ws: WorkspaceState,
		event: {
			channel: string;
			channel_type?: string;
			message?: {
				ts?: string;
				text?: string;
				user?: string;
				thread_ts?: string;
			};
		},
	): Promise<void> {
		const message = event.message;
		if (!message?.ts) return;

		const rawText = this.truncateRawText(message.text ?? "");
		const editedAt = new Date().toISOString();
		await ws.store.updateMessage(event.channel, message.ts, {
			text: rawText,
			editedAt,
		});

		const threadKey = this.getThreadKey(
			event.channel,
			message.ts,
			message.thread_ts,
		);
		try {
			await ws.threadMemory.updateMessageByTs(
				event.channel,
				threadKey,
				message.ts,
				{
					content: rawText,
					isEdited: true,
					userId: message.user,
				},
			);
		} catch (error) {
			logger.logWarning(
				"Failed to update thread memory for edited message",
				String(error),
			);
		}
	}

	private async handleMessageDeleted(
		ws: WorkspaceState,
		event: {
			channel: string;
			channel_type?: string;
			deleted_ts?: string;
			previous_message?: { ts?: string; thread_ts?: string };
		},
	): Promise<void> {
		const deletedTs = event.deleted_ts ?? event.previous_message?.ts;
		if (!deletedTs) return;

		await ws.store.deleteMessage(event.channel, deletedTs);

		const threadKey = this.getThreadKey(
			event.channel,
			deletedTs,
			event.previous_message?.thread_ts,
		);
		try {
			await ws.threadMemory.deleteMessageByTs(
				event.channel,
				threadKey,
				deletedTs,
			);
		} catch (error) {
			logger.logWarning(
				"Failed to delete message from thread memory",
				String(error),
			);
		}
	}

	private getThreadKey(
		channelId: string,
		messageTs: string,
		threadTs?: string,
	): string {
		if (channelId.startsWith("D")) {
			return channelId;
		}
		return threadTs ?? messageTs;
	}

	private async createContext(
		ws: WorkspaceState,
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
		const preparedMessage = prepared ?? (await this.prepareMessage(ws, event));
		const { text, rawText, attachments } = preparedMessage;
		const userName =
			preparedMessage.userName ??
			(await this.getUserInfo(ws, event.user)).userName;

		let channelName: string | undefined;
		try {
			if (event.channel.startsWith("C") || event.channel.startsWith("G")) {
				const cached = ws.channelCache.get(event.channel);
				if (cached) {
					channelName = `#${cached}`;
				} else {
					const result = await this.callSlack(
						ws,
						() =>
							ws.webClient.conversations.info({
								channel: event.channel,
							}),
						"conversations.info",
					);
					if (result.channel?.name) {
						ws.channelCache.set(event.channel, result.channel.name);
						channelName = `#${result.channel.name}`;
					}
				}
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
		const threadKey = this.getThreadKey(event.channel, userMessageTs, threadTs);

		const responseHandlers = createResponseHandlers({
			channelId: event.channel,
			webClient: ws.webClient,
			store: ws.store,
			callSlack: (fn, method) => this.callSlack(ws, fn, method),
			obfuscateUsernames: (t) => this.obfuscateUsernames(ws, t),
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
				teamId: ws.teamId,
				channel: event.channel,
				ts: event.ts,
				threadTs,
				attachments,
			},
			teamId: ws.teamId,
			channelName,
			store: ws.store,
			channels: this.getChannels(ws),
			users: this.getUsers(ws),
			threadKey,
			useThread,
			...responseHandlers,
		};
	}

	private async backfillChannel(
		ws: WorkspaceState,
		channelId: string,
	): Promise<number> {
		const lastTs = ws.store.getLastTimestamp(channelId);

		type Message = NonNullable<
			ConversationsHistoryResponse["messages"]
		>[number];
		const allMessages: Message[] = [];

		let cursor: string | undefined;
		let pageCount = 0;
		const maxPages = this.historyMaxPages;

		do {
			const result = await this.callSlack(
				ws,
				() =>
					ws.webClient.conversations.history({
						channel: channelId,
						oldest: lastTs ?? undefined,
						inclusive: false,
						limit: this.historyLimit,
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
			if (msg.user === ws.botUserId) return true;
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
			const isBotMessage = msg.user === ws.botUserId;
			const attachments = msg.files
				? await this.buildAttachments(
						ws,
						channelId,
						msg.files as SlackFile[],
						msgTs,
					)
				: [];
			const rawText = this.truncateRawText(msg.text || "");

			if (isBotMessage) {
				await ws.store.logMessage(channelId, {
					date: new Date(Number.parseFloat(msgTs) * 1000).toISOString(),
					ts: msgTs,
					threadTs: msg.thread_ts,
					user: "bot",
					text: rawText,
					attachments,
					isBot: true,
				});
				const threadKey = this.getThreadKey(channelId, msgTs, msg.thread_ts);
				try {
					await ws.threadMemory.addMessage(channelId, threadKey, {
						role: "assistant",
						content: rawText,
						messageTs: msgTs,
						metadata: {
							userName: "bot",
							attachments: attachments.map((a) => a.local),
						},
					});
				} catch (error) {
					logger.logWarning(
						"Failed to backfill bot message into thread memory",
						String(error),
					);
				}
			} else {
				const { userName, displayName } = await this.getUserInfo(
					ws,
					msg.user || "",
				);
				await ws.store.logMessage(channelId, {
					date: new Date(Number.parseFloat(msgTs) * 1000).toISOString(),
					ts: msgTs,
					threadTs: msg.thread_ts,
					user: msg.user || "",
					userName,
					displayName,
					text: rawText,
					attachments,
					isBot: false,
				});
				const threadKey = this.getThreadKey(channelId, msgTs, msg.thread_ts);
				try {
					await ws.threadMemory.addMessage(channelId, threadKey, {
						role: "user",
						content: rawText,
						userId: msg.user || "",
						messageTs: msgTs,
						metadata: {
							userName,
							displayName,
							attachments: attachments.map((a) => a.local),
						},
					});
				} catch (error) {
					logger.logWarning(
						"Failed to backfill user message into thread memory",
						String(error),
					);
				}
			}
		}

		return relevantMessages.length;
	}

	private resolveBackfillTargets(
		ws: WorkspaceState,
		channelIds?: string[],
	): Array<{ id: string; name: string }> {
		if (channelIds && channelIds.length > 0) {
			return channelIds.map((id) => ({
				id,
				name: ws.channelCache.get(id) ?? id,
			}));
		}

		const allChannels = Array.from(ws.channelCache.entries());
		const filtered = allChannels.filter(([channelId, channelName]) =>
			this.shouldBackfillChannel(channelId, channelName),
		);
		if (this.backfillInclude || this.backfillExclude.size > 0) {
			logger.logInfo(
				`Backfill filtered to ${filtered.length} of ${allChannels.length} channels.`,
			);
		}
		return filtered.map(([id, name]) => ({ id, name }));
	}

	private async runBackfill(
		ws: WorkspaceState,
		options: {
			channelIds?: string[];
			source: "startup" | "manual";
		},
	): Promise<void> {
		const { channelIds, source } = options;
		if (source === "startup" && !this.backfillOnStartup) {
			logger.logInfo("Backfill disabled on startup.");
			return;
		}

		const targets = this.resolveBackfillTargets(ws, channelIds);
		if (targets.length === 0) {
			logger.logInfo("Backfill skipped: no matching channels.");
			return;
		}

		const startTime = Date.now();
		logger.logBackfillStart(targets.length);

		const queue = [...targets];
		const concurrency = Math.min(this.backfillConcurrency, targets.length);

		const worker = async (): Promise<number> => {
			let localTotal = 0;
			while (true) {
				const current = queue.shift();
				if (!current) {
					break;
				}
				try {
					const count = await this.backfillChannel(ws, current.id);
					if (count > 0) {
						logger.logBackfillChannel(current.name, count);
					}
					localTotal += count;
				} catch (error) {
					logger.logWarning(
						`Failed to backfill channel #${current.name}`,
						String(error),
					);
				}
			}
			return localTotal;
		};

		const results = await Promise.all(
			Array.from({ length: concurrency }, () => worker()),
		);
		const totalMessages = results.reduce((sum, count) => sum + count, 0);

		const durationMs = Date.now() - startTime;
		logger.logBackfillComplete(totalMessages, durationMs);
	}

	async backfill(channelIds?: string[]): Promise<void> {
		const ws = await this.getWorkspaceState(this.defaultTeamId);
		if (!ws) return;
		await this.ensureBotUserId(ws);
		await Promise.all([this.fetchChannels(ws), this.fetchUsers(ws)]);
		await this.runBackfill(ws, { channelIds, source: "manual" });
	}

	async backfillTeam(teamId: string, channelIds?: string[]): Promise<void> {
		const ws = await this.getWorkspaceState(teamId);
		if (!ws) return;
		await this.ensureBotUserId(ws);
		await Promise.all([this.fetchChannels(ws), this.fetchUsers(ws)]);
		await this.runBackfill(ws, { channelIds, source: "manual" });
	}

	async start(): Promise<void> {
		if (this.multiWorkspace) {
			await this.socketClient.start();
			logger.logConnected();
			return;
		}

		const ws = await this.getWorkspaceState(this.defaultTeamId);
		if (!ws) {
			throw new Error("Failed to resolve Slack workspace");
		}
		await this.ensureBotUserId(ws);
		await Promise.all([this.fetchChannels(ws), this.fetchUsers(ws)]);
		logger.logInfo(
			`Loaded ${ws.channelCache.size} channels, ${ws.userCache.size} users`,
		);
		await this.runBackfill(ws, { source: "startup" });

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
		return this.postMessageTeam(this.defaultTeamId, channelId, text);
	}

	async postMessageTeam(
		teamId: string,
		channelId: string,
		text: string,
	): Promise<string | null> {
		const ws = await this.getWorkspaceState(teamId);
		if (!ws) return null;
		try {
			const result = await this.callSlack(
				ws,
				() =>
					ws.webClient.chat.postMessage({
						channel: channelId,
						text,
					}),
				"chat.postMessage",
			);
			return result.ts as string;
		} catch (error) {
			logger.logWarning(
				`Failed to post message to ${channelId} (${teamId})`,
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
		return this.createSlashContextTeam(this.defaultTeamId, command);
	}

	async createSlashContextTeam(
		teamId: string,
		command: {
			command: string;
			text?: string;
			channel_id: string;
			user_id: string;
		},
	): Promise<SlackContext> {
		const ws = await this.getWorkspaceState(teamId);
		if (!ws) {
			throw new Error(`Unknown Slack workspace: ${teamId}`);
		}
		const now = Date.now();
		const ts = `${Math.floor(now / 1000)}.${(now % 1000) * 1000}`;

		const rawText = this.truncateRawText(
			`${command.command} ${command.text || ""}`.trim(),
		);
		const { userName } = await this.getUserInfo(ws, command.user_id);

		const responseHandlers = createResponseHandlers({
			channelId: command.channel_id,
			webClient: ws.webClient,
			store: ws.store,
			callSlack: (fn, method) => this.callSlack(ws, fn, method),
			obfuscateUsernames: (t) => this.obfuscateUsernames(ws, t),
		});

		const threadKey = this.getThreadKey(command.channel_id, ts);

		return {
			message: {
				text: rawText,
				rawText,
				user: command.user_id,
				userName,
				teamId: ws.teamId,
				channel: command.channel_id,
				ts,
				attachments: [],
			},
			teamId: ws.teamId,
			channelName: ws.channelCache.get(command.channel_id),
			store: ws.store,
			channels: this.getChannels(ws),
			users: this.getUsers(ws),
			threadKey,
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
		return this.createScheduledContextTeam(
			this.defaultTeamId,
			channelId,
			prompt,
		);
	}

	async createScheduledContextTeam(
		teamId: string,
		channelId: string,
		prompt: string,
	): Promise<SlackContext> {
		const ws = await this.getWorkspaceState(teamId);
		if (!ws) {
			throw new Error(`Unknown Slack workspace: ${teamId}`);
		}
		const now = Date.now();
		const ts = `${Math.floor(now / 1000)}.${(now % 1000) * 1000}`;

		const responseHandlers = createResponseHandlers({
			channelId,
			webClient: ws.webClient,
			store: ws.store,
			callSlack: (fn, method) => this.callSlack(ws, fn, method),
			obfuscateUsernames: (t) => this.obfuscateUsernames(ws, t),
		});

		const safePrompt = this.truncateRawText(prompt);
		const threadKey = this.getThreadKey(channelId, ts);
		return {
			message: {
				text: safePrompt,
				rawText: safePrompt,
				user: "scheduled",
				userName: "Scheduled Task",
				teamId: ws.teamId,
				channel: channelId,
				ts,
				attachments: [],
			},
			teamId: ws.teamId,
			channelName: ws.channelCache.get(channelId),
			store: ws.store,
			channels: this.getChannels(ws),
			users: this.getUsers(ws),
			threadKey,
			useThread: false,
			...responseHandlers,
		};
	}
}
