/**
 * Agent Core - Event-Driven LLM Interaction Engine
 *
 * This module provides the central Agent class that orchestrates all LLM
 * communication, tool execution, and state management for the Composer CLI.
 * It implements an event-driven architecture that enables real-time streaming,
 * concurrent tool execution, and extensible transport layers.
 *
 * ## Architecture Overview
 *
 * ```
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │                              Agent                                       │
 * │  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────────────────┐ │
 * │  │   State     │  │  Transport   │  │     Context Sources             │ │
 * │  │ - messages  │  │ - Anthropic  │  │ - TodoContextSource             │ │
 * │  │ - model     │  │ - OpenAI     │  │ - BackgroundTaskContextSource   │ │
 * │  │ - tools     │  │ - Google     │  │ - LspContextSource              │ │
 * │  │ - streaming │  │ - Custom     │  │ - FrameworkPreferenceContext    │ │
 * │  └─────────────┘  └──────────────┘  └─────────────────────────────────┘ │
 * │         │                │                         │                     │
 * │         ▼                ▼                         ▼                     │
 * │  ┌─────────────────────────────────────────────────────────────────────┐│
 * │  │                     Event Emitter                                   ││
 * │  │  message_start, message_update, message_end, tool_execution_*       ││
 * │  └─────────────────────────────────────────────────────────────────────┘│
 * │                                 │                                        │
 * └─────────────────────────────────┼────────────────────────────────────────┘
 *                                   ▼
 *                          ┌───────────────────┐
 *                          │    Subscribers    │
 *                          │  - TUI Renderer   │
 *                          │  - Session Mgr    │
 *                          │  - JSONL Writer   │
 *                          └───────────────────┘
 * ```
 *
 * ## Event Flow
 *
 * When `agent.prompt()` is called, the following sequence occurs:
 *
 * 1. **agent_start**: Signals the beginning of a prompt cycle
 * 2. **message_start**: Message envelope begins (user or assistant)
 * 3. **message_end**: Message envelope completes (user or assistant)
 * 4. **content_block_delta**: Streaming text/thinking content
 * 5. **tool_execution_start**: Tool call initiated
 * 6. **tool_execution_end**: Tool call completed
 * 7. **message_update**: Partial message with accumulated content
 * 8. **agent_end**: Prompt cycle completed
 *
 * ## Message Transformation
 *
 * Messages are transformed through a pipeline before being sent to the LLM:
 *
 * 1. **App Messages**: Internal format with attachments, metadata
 * 2. **Message Transform**: Convert attachments to content blocks
 * 3. **Provider Normalization**: Adapt to target provider's format
 * 4. **System Prompt Injection**: Add context from context sources
 *
 * ## Thinking/Reasoning Support
 *
 * The agent supports extended thinking for compatible models:
 *
 * | Level   | Description                              |
 * |---------|------------------------------------------|
 * | off     | No extended thinking                     |
 * | minimal | Brief chain-of-thought                   |
 * | low     | Short reasoning steps                    |
 * | medium  | Moderate reasoning depth                 |
 * | high    | Deep reasoning with exploration          |
 * | max     | Maximum reasoning effort                 |
 *
 * ## Abort and Partial Handling
 *
 * The agent supports graceful interruption:
 *
 * - `abort()`: Cancel current request, discard partial response
 * - `abortAndKeepPartial()`: Cancel but preserve partial content
 *
 * @module agent/agent
 */

import { validate as uuidValidate } from "uuid";
import { createLogger } from "../utils/logger.js";
import {
	describeToolActivity,
	describeToolDisplayName,
	summarizeToolBatch,
	summarizeToolUse,
} from "../utils/tool-use-summary.js";
import {
	AgentContextManager,
	type AgentContextSource,
	type ContextLoadResult,
} from "./context-manager.js";
import { convertAppMessagesToLlm, isCoreMessage } from "./custom-messages.js";
import {
	type PreprocessMessagesFn,
	chainPreprocessMessages,
	defaultPreprocessMessages,
} from "./preprocess-messages.js";
import type {
	AgentEvent,
	AgentState,
	AgentTool,
	AgentTransport,
	Api,
	AppMessage,
	AssistantMessage,
	Attachment,
	ImageContent,
	Message,
	Model,
	QueuedMessage,
	ReasoningEffort,
	TextContent,
	ThinkingLevel,
	ToolResultMessage,
	UserMessage,
	UserMessageWithAttachments,
} from "./types.js";

const logger = createLogger("agent");

/**
 * Default message transformer that converts app messages to LLM-ready format.
 *
 * This transformer handles:
 * - Filtering to valid message roles (user, assistant, toolResult)
 * - Expanding user message attachments into content blocks
 * - Converting images to base64 image content
 * - Converting documents to text content with filename headers
 *
 * @param messages - Array of app messages to transform
 * @returns Array of messages ready for LLM consumption
 */
function defaultMessageTransformer(messages: AppMessage[]): Message[] {
	return (
		convertAppMessagesToLlm(messages)
			// Filter to only roles the LLM understands
			.filter(
				(m) =>
					m.role === "user" ||
					m.role === "assistant" ||
					m.role === "toolResult",
			)
			.map((message) => {
				// Non-user messages pass through unchanged
				if (message.role !== "user") {
					return message as Message;
				}

				// Handle user messages with attachments
				const { attachments, ...rest } = message as UserMessageWithAttachments;
				if (!attachments || attachments.length === 0) {
					return rest as Message;
				}

				// Expand attachments into content array
				// Start with existing content (may be string or array)
				const content: Array<TextContent | ImageContent> = Array.isArray(
					rest.content,
				)
					? [...rest.content]
					: [{ type: "text", text: rest.content }];

				// Convert each attachment to appropriate content type
				for (const attachment of attachments) {
					if (attachment.type === "image") {
						// Images become image content blocks with base64 data
						content.push({
							type: "image",
							data: attachment.content,
							mimeType: attachment.mimeType,
						} as ImageContent);
					} else if (
						attachment.type === "document" &&
						attachment.extractedText
					) {
						// Documents become text blocks with filename headers
						content.push({
							type: "text",
							text: `\n\n[Document: ${attachment.fileName}]\n${attachment.extractedText}`,
						} as TextContent);
					}
				}

				return { ...rest, content } as Message;
			})
	);
}

/**
 * Maps internal thinking level to provider reasoning effort parameter.
 *
 * Different providers have different reasoning/thinking capabilities.
 * This function normalizes our internal levels to what providers support.
 *
 * @param level - Internal thinking level
 * @returns Provider-specific reasoning effort, or undefined if disabled
 */
function mapThinkingLevel(level: ThinkingLevel): ReasoningEffort | undefined {
	switch (level) {
		case "off":
			return undefined; // No extended thinking
		case "minimal":
			return "minimal"; // Brief chain-of-thought
		case "low":
			return "low"; // Short reasoning steps
		case "medium":
			return "medium"; // Moderate depth
		case "high":
		case "max":
			return "high"; // Maximum reasoning (max maps to high for providers)
		default:
			return undefined;
	}
}

function buildPromptOnlyToolBatchSummaryMessage(
	summaryLabels: string[],
): UserMessage {
	const bulletList = summaryLabels.map((label) => `- ${label}`).join("\n");
	return {
		role: "user",
		content: [
			{
				type: "text",
				text: `The following is a transient summary of the most recent tool activity:\n${bulletList}`,
			},
		],
		timestamp: Date.now(),
	};
}

/**
 * Ensures prior assistant messages remain provider-compatible when switching models mid-session.
 *
 * When users switch between providers (e.g., Anthropic → OpenAI), previous assistant
 * messages may contain provider-specific content like "thinking" blocks. This function
 * converts those blocks to a format all providers can understand.
 *
 * ## Problem
 *
 * Anthropic's thinking blocks look like: `{ type: "thinking", thinking: "..." }`
 * OpenAI doesn't understand this format and may error or ignore it.
 *
 * ## Solution
 *
 * Convert thinking blocks to text: `<thinking>...</thinking>` which all providers
 * can process as regular text content.
 *
 * @param messages - Messages from conversation history
 * @param targetModel - The model that will receive these messages
 * @returns Messages with thinking blocks normalized for the target provider
 */
function normalizeMessagesForProvider(
	messages: Message[],
	targetModel: Model<Api>,
): Message[] {
	return messages.map((msg) => {
		if (msg.role !== "assistant") {
			return msg;
		}
		const shouldConvertThinking =
			msg.provider !== targetModel.provider ||
			msg.api !== targetModel.api ||
			!targetModel.reasoning;
		if (!shouldConvertThinking) {
			return msg;
		}
		const content = msg.content.map((block) => {
			if (block.type === "thinking") {
				return {
					type: "text",
					text: `<thinking>${block.thinking}</thinking>`,
				} as TextContent;
			}
			return block;
		});
		return { ...msg, content };
	});
}

function isDuplicateMessage(
	existing: AppMessage | undefined,
	incoming: AppMessage,
): boolean {
	if (!existing) return false;
	if (existing.role !== incoming.role) return false;
	if ("timestamp" in existing && "timestamp" in incoming) {
		if (existing.timestamp !== incoming.timestamp) return false;
	}
	if (existing.role === "toolResult" && incoming.role === "toolResult") {
		return existing.toolCallId === incoming.toolCallId;
	}
	// For assistant messages, compare stopReason and content fingerprint to avoid
	// discarding distinct messages that share a timestamp (e.g. parallel tool calls).
	if (existing.role === "assistant" && incoming.role === "assistant") {
		if (existing.stopReason !== incoming.stopReason) return false;
		if (existing.content.length !== incoming.content.length) return false;
		// Compare first content block identity for a stronger structural check.
		const a = existing.content[0];
		const b = incoming.content[0];
		if (a && b) {
			if (a.type !== b.type) return false;
			if (a.type === "toolCall" && b.type === "toolCall") {
				if (a.id !== b.id) return false;
			} else if (a.type === "text" && b.type === "text") {
				if (a.text !== b.text) return false;
			} else if (a.type === "thinking" && b.type === "thinking") {
				if (a.thinking !== b.thinking) return false;
			}
		}
	}
	return true;
}

/**
 * Configuration options for creating an Agent instance.
 */
export interface AgentOptions {
	/** Initial state to override defaults (system prompt, model, tools, etc.) */
	initialState?: Partial<AgentState>;
	/** Transport implementation for LLM provider communication */
	transport: AgentTransport;
	/** Optional transformer to convert app messages to provider-specific format */
	messageTransformer?: (
		messages: AppMessage[],
	) => Message[] | Promise<Message[]>;
	/** Optional message preprocessor executed immediately before provider invocation */
	preprocessMessages?: PreprocessMessagesFn;
	/** Disable Composer's built-in preprocessing (not recommended) */
	disableDefaultPreprocessMessages?: boolean;
	/** Optional context sources for environment injection */
	contextSources?: AgentContextSource[];
}

/**
 * Core Agent class implementing event-driven LLM interaction.
 *
 * The Agent manages conversation state, tool execution, and streaming responses
 * across multiple LLM providers through an abstracted transport layer.
 *
 * @example
 * ```typescript
 * const agent = new Agent({
 *   transport: new AnthropicTransport(apiKey),
 *   initialState: { model: claudeSonnet4, tools: codingTools }
 * });
 *
 * agent.subscribe((event) => {
 *   if (event.type === 'content_block_delta') {
 *     process.stdout.write(event.text);
 *   }
 * });
 *
 * await agent.prompt("Create a hello world function");
 * ```
 */
export class Agent {
	private _state: AgentState;
	private listeners: Array<(e: AgentEvent) => void> = [];
	private abortController?: AbortController;
	private transport: AgentTransport;
	private messageTransformer: (
		messages: AppMessage[],
	) => Message[] | Promise<Message[]>;
	private preprocessMessages?: PreprocessMessagesFn;
	private steeringQueue: Array<QueuedMessage<AppMessage>> = [];
	private followUpQueue: Array<QueuedMessage<AppMessage>> = [];
	private nextRunHistoryQueue: AppMessage[] = [];
	private nextRunPromptOnlyQueue: Message[] = [];
	private promptOnlyQueue: Message[] = [];
	private nextRunSystemPromptAdditions: string[] = [];
	private steeringMode: "all" | "one" = "all";
	private followUpMode: "all" | "one" = "all";
	private queueMode: "all" | "one" = "all";
	private nextQueuedMessageId = 1;
	private runningPrompt?: Promise<void>;
	private resolveRunningPrompt?: () => void;
	private contextManager: AgentContextManager;
	private activeToolBatchIds: Set<string> | null = null;
	private completedToolBatch: Array<{
		toolCallId: string;
		toolName: string;
		args: Record<string, unknown>;
		isError: boolean;
		tool?: Pick<AgentTool, "getToolUseSummary" | "getActivityDescription">;
	}> = [];

	/**
	 * Creates a new Agent instance.
	 *
	 * @param opts - Configuration options including transport and initial state
	 */
	constructor(opts: AgentOptions) {
		this.transport = opts.transport;
		this.messageTransformer =
			opts.messageTransformer ??
			((messages) => defaultMessageTransformer(messages));
		this.preprocessMessages = chainPreprocessMessages(
			opts.disableDefaultPreprocessMessages
				? undefined
				: defaultPreprocessMessages,
			opts.preprocessMessages,
		);

		this.contextManager = new AgentContextManager();
		if (opts.contextSources) {
			for (const source of opts.contextSources) {
				this.contextManager.addSource(source);
			}
		}

		const {
			systemPrompt,
			model,
			thinkingLevel,
			tools,
			queueMode,
			steeringMode,
			followUpMode,
			...restInitialState
		} = opts.initialState ?? {};
		this.queueMode = queueMode ?? "all";
		this.steeringMode = steeringMode ?? queueMode ?? "all";
		this.followUpMode = followUpMode ?? queueMode ?? "all";

		if (restInitialState.user) {
			if (
				!uuidValidate(restInitialState.user.id) ||
				!uuidValidate(restInitialState.user.orgId)
			) {
				throw new Error("Invalid user ID or Org ID: Must be a valid UUID");
			}
		}

		this._state = {
			systemPrompt: systemPrompt ?? "",
			model:
				model ??
				((): never => {
					throw new Error("Agent requires an initial model");
				})(),
			thinkingLevel: thinkingLevel ?? "off",
			tools: tools ?? [],
			messages: [],
			isStreaming: false,
			streamMessage: null,
			pendingToolCalls: new Map(),
			sandbox: restInitialState.sandbox,
			sandboxMode: restInitialState.sandboxMode ?? null,
			sandboxEnabled:
				restInitialState.sandboxEnabled ?? Boolean(restInitialState.sandbox),
			...restInitialState,
			queueMode: this.queueMode,
			steeringMode: this.steeringMode,
			followUpMode: this.followUpMode,
		};
	}

	/**
	 * Gets the current agent state (read-only).
	 *
	 * @returns The current state including messages, model, tools, and streaming status
	 */
	get state(): Readonly<AgentState> {
		return this._state;
	}

	/**
	 * Gets detailed status of all context sources.
	 *
	 * Context sources provide dynamic content injected into the system prompt,
	 * such as todo lists, LSP diagnostics, and IDE information.
	 *
	 * @returns Promise resolving to context load result with per-source status
	 *
	 * @example
	 * ```typescript
	 * const result = await agent.getContextSourceStatus();
	 * for (const source of result.sourceStatuses) {
	 *   console.log(`${source.name}: ${source.status} (${source.durationMs}ms)`);
	 * }
	 * ```
	 */
	async getContextSourceStatus(): Promise<ContextLoadResult> {
		return this.contextManager.getCombinedSystemPromptWithStatus();
	}

	/**
	 * Optionally probes the underlying transport for connectivity checks.
	 */
	async probeTransport(): Promise<void> {
		if (this.transport.ping) {
			await this.transport.ping();
		}
	}

	/**
	 * Subscribes to agent events (streaming deltas, tool calls, errors, etc.).
	 *
	 * @param fn - Event listener function to be called on each event
	 * @returns Unsubscribe function to remove the listener
	 *
	 * @example
	 * ```typescript
	 * const unsubscribe = agent.subscribe((event) => {
	 *   if (event.type === 'content_block_delta') {
	 *     console.log(event.text);
	 *   }
	 * });
	 *
	 * // Later, to stop listening:
	 * unsubscribe();
	 * ```
	 */
	subscribe(fn: (e: AgentEvent) => void): () => void {
		this.listeners.push(fn);
		return () => {
			const idx = this.listeners.indexOf(fn);
			if (idx >= 0) this.listeners.splice(idx, 1);
		};
	}

	/**
	 * Emits an event to all subscribed listeners.
	 * Errors in listeners are caught and logged to prevent cascading failures.
	 *
	 * @param event - The event to emit
	 */
	private emit(event: AgentEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (error) {
				logger.error(
					"Error in agent event listener",
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		}
	}

	private async dequeueSteeringMessages<T>(): Promise<QueuedMessage<T>[]> {
		if (this.steeringQueue.length === 0) {
			return [];
		}
		if (this.steeringMode === "one") {
			const next = this.steeringQueue.shift();
			return next ? [next as QueuedMessage<T>] : [];
		}
		const queued = this.steeringQueue.splice(0) as QueuedMessage<T>[];
		return queued;
	}

	private async dequeueFollowUpMessages<T>(): Promise<QueuedMessage<T>[]> {
		if (this.followUpQueue.length === 0) {
			return [];
		}
		if (this.followUpMode === "one") {
			const next = this.followUpQueue.shift();
			return next ? [next as QueuedMessage<T>] : [];
		}
		const queued = this.followUpQueue.splice(0) as QueuedMessage<T>[];
		return queued;
	}

	private async dequeuePromptOnlyMessages(): Promise<Message[]> {
		if (
			this.nextRunPromptOnlyQueue.length === 0 &&
			this.promptOnlyQueue.length === 0
		) {
			return [];
		}
		const queued = [...this.nextRunPromptOnlyQueue, ...this.promptOnlyQueue];
		this.nextRunPromptOnlyQueue = [];
		this.promptOnlyQueue = [];
		return queued;
	}

	private dequeueNextRunHistoryMessages(): AppMessage[] {
		if (this.nextRunHistoryQueue.length === 0) {
			return [];
		}
		const queued = [...this.nextRunHistoryQueue];
		this.nextRunHistoryQueue = [];
		return queued;
	}

	private dequeueNextRunSystemPromptAdditions(): string[] {
		if (this.nextRunSystemPromptAdditions.length === 0) {
			return [];
		}
		const queued = [...this.nextRunSystemPromptAdditions];
		this.nextRunSystemPromptAdditions = [];
		return queued;
	}

	private async dequeueQueuedMessages<T>(): Promise<QueuedMessage<T>[]> {
		return this.dequeueFollowUpMessages<T>();
	}

	/**
	 * Sets the system prompt that provides context and instructions to the model.
	 *
	 * @param v - The system prompt text
	 */
	setSystemPrompt(v: string): void {
		this._state.systemPrompt = v;
	}

	/**
	 * Sets the active LLM model for this agent.
	 *
	 * @param m - The model configuration
	 */
	setModel(m: Model<Api>): void {
		this._state.model = m;
		if (!m.reasoning && this._state.thinkingLevel !== "off") {
			this._state.thinkingLevel = "off";
		}
	}

	/**
	 * Sets the thinking/reasoning level for extended reasoning models.
	 *
	 * @param l - Thinking level: "off", "minimal", "low", "medium", "high", "max"
	 */
	setThinkingLevel(l: ThinkingLevel): void {
		this._state.thinkingLevel = l;
	}

	/**
	 * Controls how queued steering messages are drained between turns.
	 * "all" (default) sends the full queue; "one" sends a single item per turn.
	 */
	setSteeringMode(mode: "all" | "one"): void {
		this.steeringMode = mode;
		this.queueMode = mode;
		this._state.steeringMode = mode;
		this._state.queueMode = mode;
	}

	getSteeringMode(): "all" | "one" {
		return this.steeringMode;
	}

	/**
	 * Controls how queued follow-up messages are drained between turns.
	 * "all" (default) sends the full queue; "one" sends a single item per turn.
	 */
	setFollowUpMode(mode: "all" | "one"): void {
		this.followUpMode = mode;
		this._state.followUpMode = mode;
	}

	getFollowUpMode(): "all" | "one" {
		return this.followUpMode;
	}

	/**
	 * @deprecated Use setSteeringMode/setFollowUpMode instead.
	 * Sets both steering + follow-up modes for compatibility.
	 */
	setQueueMode(mode: "all" | "one"): void {
		this.queueMode = mode;
		this._state.queueMode = mode;
		this.setSteeringMode(mode);
		this.setFollowUpMode(mode);
	}

	/**
	 * Sets the available tools that the model can invoke.
	 *
	 * @param t - Array of tool definitions with schemas and execute functions
	 */
	setTools(t: AgentTool[]): void {
		this._state.tools = t;
	}

	/**
	 * Sets the active user for this agent.
	 */
	setUser(user: AgentState["user"]): void {
		this._state.user = user;
	}

	/**
	 * Sets the active session for this agent.
	 */
	setSession(session: AgentState["session"]): void {
		this._state.session = session;
	}

	/**
	 * Sets the sampling temperature for LLM generation.
	 *
	 * @param t - Temperature value (0.0-2.0, lower = more deterministic). Pass undefined to reset to default.
	 */
	setTemperature(t: number | undefined): void {
		this._state.temperature = t;
	}

	/**
	 * Sets the top-p sampling parameter for LLM generation.
	 *
	 * @param p - Top-p value (0.0-1.0). Pass undefined to reset to default.
	 */
	setTopP(p: number | undefined): void {
		this._state.topP = p;
	}

	/**
	 * Replaces the entire message history with a new set of messages.
	 *
	 * @param ms - New message array
	 */
	replaceMessages(ms: AppMessage[]): void {
		this._state.messages = ms.slice();
	}

	/**
	 * Clear transient run state without touching message history or queued inputs.
	 *
	 * This is useful before starting a fresh run, or after operations like
	 * compaction that rewrite history while the agent is otherwise idle.
	 */
	clearTransientRunState(): void {
		this._state.isStreaming = false;
		this._state.streamMessage = null;
		this._state.pendingToolCalls.clear();
		this.activeToolBatchIds = null;
		this.completedToolBatch = [];
		this.promptOnlyQueue = [];
		this._state.error = undefined;
		this._partialAccepted = null;
	}

	/**
	 * Appends a single message to the conversation history.
	 *
	 * @param m - Message to append
	 */
	appendMessage(m: AppMessage): void {
		this._state.messages = [...this._state.messages, m];
	}

	/**
	 * Inject a message into the conversation history and emit a message_end event.
	 */
	injectMessage(m: AppMessage): void {
		this._state.messages = [...this._state.messages, m];
		this.emit({ type: "message_end", message: m });
	}

	/**
	 * Emit a transient runtime status update without mutating conversation history.
	 */
	emitStatus(status: string, details: Record<string, unknown> = {}): void {
		const normalized = status.trim();
		if (!normalized) {
			return;
		}
		this.emit({ type: "status", status: normalized, details });
	}

	/**
	 * Emit a transient runtime error without mutating conversation history.
	 */
	emitError(message: string): void {
		const normalized = message.trim();
		if (!normalized) {
			return;
		}
		this.emit({ type: "error", message: normalized });
	}

	/**
	 * Emit a compaction lifecycle event without mutating conversation history.
	 */
	emitCompaction(
		event: Omit<Extract<AgentEvent, { type: "compaction" }>, "type">,
	): void {
		this.emit({ type: "compaction", ...event });
	}

	/**
	 * Queue a prompt-only message for the next run without persisting it to history.
	 */
	queueNextRunPromptOnlyMessage(message: Message): void {
		this.nextRunPromptOnlyQueue.push(message);
	}

	/**
	 * Queue a persisted history message for the next run.
	 */
	queueNextRunHistoryMessage(message: AppMessage): void {
		this.nextRunHistoryQueue.push(message);
	}

	/**
	 * Queue transient system guidance for the next run.
	 */
	queueNextRunSystemPromptAddition(text: string): void {
		const normalized = text.trim();
		if (!normalized) {
			return;
		}
		this.nextRunSystemPromptAdditions.push(normalized);
	}

	/**
	 * Queues a steering message to interrupt the agent mid-run.
	 *
	 * Delivered after the current tool execution and skips remaining tools.
	 *
	 * @param m - Message to queue
	 */
	async steer(m: AppMessage): Promise<void> {
		await this.enqueueQueuedMessage("steer", m);
	}

	/**
	 * Queues a follow-up message to be processed after the agent finishes.
	 *
	 * @param m - Message to queue
	 */
	async followUp(m: AppMessage): Promise<void> {
		await this.enqueueQueuedMessage("followUp", m);
	}

	/**
	 * Re-inserts a follow-up at the front of the follow-up queue.
	 */
	async prependFollowUp(
		m: AppMessage,
		options?: { id?: number; createdAt?: number },
	): Promise<void> {
		await this.enqueueQueuedMessage("followUp", m, {
			position: "front",
			id: options?.id,
			createdAt: options?.createdAt,
		});
	}

	/**
	 * @deprecated Use steer() or followUp() instead.
	 * Defaults to follow-up semantics.
	 */
	async queueMessage(m: AppMessage): Promise<void> {
		await this.followUp(m);
	}

	private async enqueueQueuedMessage(
		kind: "steer" | "followUp",
		message: AppMessage,
		options?: {
			position?: "front" | "back";
			id?: number;
			createdAt?: number;
		},
	): Promise<void> {
		const transformed = await this.messageTransformer([message]);
		const id = options?.id ?? this.nextQueuedMessageId++;
		if (id >= this.nextQueuedMessageId) {
			this.nextQueuedMessageId = id + 1;
		}
		const queued = {
			id,
			createdAt: options?.createdAt ?? Date.now(),
			original: message,
			llm: transformed[0],
		};
		const position = options?.position ?? "back";
		if (kind === "steer") {
			if (position === "front") {
				this.steeringQueue.unshift(queued);
			} else {
				this.steeringQueue.push(queued);
			}
			return;
		}
		if (position === "front") {
			this.followUpQueue.unshift(queued);
		} else {
			this.followUpQueue.push(queued);
		}
	}

	/**
	 * Clears all messages from the conversation history.
	 */
	clearMessages(): void {
		this._state.messages = [];
	}

	/**
	 * Get the number of queued messages.
	 */
	getQueuedMessageCount(): number {
		return this.steeringQueue.length + this.followUpQueue.length;
	}

	getQueuedSteeringCount(): number {
		return this.steeringQueue.length;
	}

	getQueuedFollowUpCount(): number {
		return this.followUpQueue.length;
	}

	getQueuedMessagesSnapshot(): {
		steering: ReadonlyArray<QueuedMessage<AppMessage>>;
		followUps: ReadonlyArray<QueuedMessage<AppMessage>>;
	} {
		return {
			steering: [...this.steeringQueue],
			followUps: [...this.followUpQueue],
		};
	}

	removeQueuedMessage(id: number): QueuedMessage<AppMessage> | null {
		const steeringIndex = this.steeringQueue.findIndex(
			(message) => message.id === id,
		);
		if (steeringIndex !== -1) {
			return this.steeringQueue.splice(steeringIndex, 1)[0] ?? null;
		}
		const followUpIndex = this.followUpQueue.findIndex(
			(message) => message.id === id,
		);
		if (followUpIndex !== -1) {
			return this.followUpQueue.splice(followUpIndex, 1)[0] ?? null;
		}
		return null;
	}

	clearQueuedMessages(): Array<QueuedMessage<AppMessage>> {
		const queued = [...this.steeringQueue, ...this.followUpQueue].sort(
			(a, b) => a.createdAt - b.createdAt || a.id - b.id,
		);
		this.steeringQueue = [];
		this.followUpQueue = [];
		return queued;
	}

	/**
	 * Aborts the current streaming request if one is in progress.
	 */
	abort(): void {
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = undefined;
		}
	}

	/**
	 * Aborts the current streaming request and saves any partial response.
	 *
	 * Unlike `abort()`, this method preserves the partial assistant message
	 * that was being streamed, adding it to the message history. This allows
	 * users to keep useful partial responses when interrupting long generations.
	 *
	 * @returns The partial message that was saved, or null if no partial was available
	 *
	 * @example
	 * ```typescript
	 * // User presses Ctrl+C during a long response
	 * const partial = agent.abortAndKeepPartial();
	 * if (partial) {
	 *   console.log("Saved partial response:", partial.content);
	 * }
	 * ```
	 */
	abortAndKeepPartial(): AppMessage | null {
		const partialMessage = this._state.streamMessage;

		// Only save if we have an assistant message (not user message)
		if (
			partialMessage &&
			partialMessage.role === "assistant" &&
			this.abortController
		) {
			// Mark as interrupted by setting stopReason
			const savedMessage: AssistantMessage = {
				...partialMessage,
				stopReason: "aborted",
			};

			// Add to message history before aborting
			this._state.messages = [...this._state.messages, savedMessage];
			this._state.streamMessage = null;
			this._partialAccepted = savedMessage;

			logger.info("Saved partial message on interrupt", {
				contentLength: JSON.stringify(savedMessage.content).length,
			});

			// Now abort
			this.abort();

			return savedMessage;
		}

		// No partial to save, just abort
		this.abort();

		return null;
	}

	/** Tracks if a partial message was accepted during abort */
	private _partialAccepted: AppMessage | null = null;

	/**
	 * Returns a promise that resolves when the current prompt completes.
	 * Returns immediately resolved promise if no prompt is running.
	 */
	waitForIdle(): Promise<void> {
		return this.runningPrompt ?? Promise.resolve();
	}

	/**
	 * Clear all messages and state. Call abort() first if a prompt is in flight.
	 */
	reset(): void {
		this._state.messages = [];
		this._state.isStreaming = false;
		this._state.streamMessage = null;
		this._state.pendingToolCalls.clear();
		this.activeToolBatchIds = null;
		this.completedToolBatch = [];
		this.nextRunHistoryQueue = [];
		this.nextRunPromptOnlyQueue = [];
		this.promptOnlyQueue = [];
		this.nextRunSystemPromptAdditions = [];
		this._state.error = undefined;
		this.steeringQueue = [];
		this.followUpQueue = [];
		this.abortController = undefined;
		this.runningPrompt = undefined;
		this.resolveRunningPrompt = undefined;
		// Note: Do NOT clear listeners - they contain the TUI subscription
		// and must persist across resets for UI updates to work
	}

	/**
	 * Sends a prompt to the model and processes the response, including tool calls.
	 *
	 * This is the main entry point for interacting with the agent. It handles:
	 * - Building the user message with optional image/document attachments
	 * - Streaming the model's response
	 * - Executing any tool calls made by the model
	 * - Automatic retries for tool execution
	 *
	 * @param input - The user's text prompt
	 * @param attachments - Optional images or documents to include with the prompt
	 *
	 * @example
	 * ```typescript
	 * await agent.prompt("Read the package.json file");
	 *
	 * // With image attachment
	 * await agent.prompt("What's in this screenshot?", [{
	 *   type: "image",
	 *   content: base64Data,
	 *   mimeType: "image/png"
	 * }]);
	 * ```
	 */
	async prompt(input: string, attachments?: Attachment[]): Promise<void> {
		// Prevent concurrent prompts
		if (this.runningPrompt) {
			throw new Error(
				"A prompt is already in progress. Wait for it to complete before starting another.",
			);
		}

		this.clearTransientRunState();

		// Set up running prompt tracking
		this.runningPrompt = new Promise<void>((resolve) => {
			this.resolveRunningPrompt = resolve;
		});

		for (const queuedMessage of this.dequeueNextRunHistoryMessages()) {
			this.injectMessage(queuedMessage);
		}

		const userMessage: UserMessageWithAttachments = {
			role: "user",
			content: input,
			attachments: attachments?.length ? attachments : undefined,
			timestamp: Date.now(),
		};

		this._state.messages = [...this._state.messages, userMessage];
		this._state.isStreaming = true;

		const abortController = new AbortController();
		this.abortController = abortController;

		this.emit({ type: "agent_start" });

		let aborted = false;
		let lastStopReason: import("./types.js").StopReason | undefined;

		try {
			const transformedMessages = await this.messageTransformer(
				this._state.messages,
			);
			const messagesToSend = normalizeMessagesForProvider(
				transformedMessages,
				this._state.model,
			);

			// Determine reasoning level
			const level = this._state.thinkingLevel;
			const reasoning = this._state.model.reasoning
				? mapThinkingLevel(level)
				: undefined;

			// Inject Context from Environment (Terrarium Principle)
			let systemPrompt = this._state.systemPrompt;
			const nextRunSystemPromptAdditions =
				this.dequeueNextRunSystemPromptAdditions();
			if (nextRunSystemPromptAdditions.length > 0) {
				systemPrompt = `${systemPrompt}\n\n${nextRunSystemPromptAdditions.join("\n\n")}`;
			}
			try {
				const contextAdditions =
					await this.contextManager.getCombinedSystemPrompt();
				if (contextAdditions) {
					systemPrompt += `\n\n${contextAdditions}`;
				}
			} catch (error) {
				logger.warn("Failed to inject environmental context", {
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				});
			}

			const runConfig = {
				systemPrompt,
				tools: this._state.tools,
				model: this._state.model,
				reasoning,
				reasoningSummary: this._state.reasoningSummary,
				preprocessMessages: this.preprocessMessages,
				getSteeringMessages: async <T>() => this.dequeueSteeringMessages<T>(),
				getFollowUpMessages: async <T>() => this.dequeueFollowUpMessages<T>(),
				getPromptOnlyMessages: async () => this.dequeuePromptOnlyMessages(),
				user: this._state.user,
				session: this._state.session,
				sandbox: this._state.sandbox,
				temperature: this._state.temperature,
				topP: this._state.topP,
			};

			for await (const event of this.transport.run(
				messagesToSend, // Include userMessage in messages array
				userMessage,
				runConfig,
				abortController.signal,
			)) {
				if (event.type === "message_start") {
					this._state.streamMessage = isCoreMessage(event.message)
						? event.message
						: null;
					this.emit(event);
				} else if (event.type === "message_update") {
					this._state.streamMessage = isCoreMessage(event.message)
						? event.message
						: null;
					this.emit(event);
				} else if (event.type === "message_end") {
					this._state.streamMessage = null;
					const incoming = event.message as AppMessage;
					const lastMessage =
						this._state.messages[this._state.messages.length - 1];
					if (!isDuplicateMessage(lastMessage, incoming)) {
						this._state.messages = [...this._state.messages, incoming];
					}
					// Track last stop reason for overflow detection
					if (
						"stopReason" in event.message &&
						event.message.stopReason !== undefined
					) {
						lastStopReason = event.message.stopReason;
					}
					this.primeToolBatch(incoming);
					this.emit(event);
				} else if (event.type === "tool_execution_start") {
					this.handleToolExecutionStart(event);
				} else if (event.type === "tool_execution_update") {
					this.handleToolExecutionUpdate(event);
				} else if (event.type === "tool_execution_end") {
					this.handleToolExecutionEnd(event);
				} else {
					this.emit(event);
				}
			}
		} catch (error: unknown) {
			if (error instanceof Error && error.name === "AbortError") {
				aborted = true;
			} else {
				this._state.error =
					error instanceof Error ? error.message : String(error);
				throw error;
			}
		} finally {
			this._state.isStreaming = false;
			if (this.abortController === abortController) {
				this.abortController = undefined;
			}
			// Clean up running prompt tracking
			this.resolveRunningPrompt?.();
			this.runningPrompt = undefined;
			this.resolveRunningPrompt = undefined;
			if (this._state.pendingToolCalls.size > 0) {
				const reason = aborted
					? "Error: Operation aborted"
					: "Error: Tool execution did not complete";
				this.resolvePendingToolCalls(reason);
			}

			const partialAccepted = this._partialAccepted;
			this._partialAccepted = null;

			this.emit({
				type: "agent_end",
				messages: this._state.messages,
				aborted,
				partialAccepted: partialAccepted ?? undefined,
				stopReason: lastStopReason,
			});
		}
	}

	/**
	 * Continue the agent conversation from existing messages without adding a new user message.
	 * Useful for overflow recovery after compaction, or resuming a partial response.
	 *
	 * @param options - Optional configuration for continuation
	 */
	async continue(options?: {
		/** Override the system prompt for this continuation */
		systemPromptOverride?: string;
		/**
		 * Provider-only user instruction appended for this continuation.
		 * Not persisted to session history or shown in the UI.
		 */
		continuationPrompt?: string;
	}): Promise<void> {
		// Prevent concurrent prompts
		if (this.runningPrompt) {
			throw new Error(
				"A prompt is already in progress. Wait for it to complete before starting another.",
			);
		}

		// Check we have messages to continue from
		if (this._state.messages.length === 0) {
			throw new Error("No messages to continue from");
		}

		this.clearTransientRunState();

		// Set up running prompt tracking
		this.runningPrompt = new Promise<void>((resolve) => {
			this.resolveRunningPrompt = resolve;
		});

		for (const queuedMessage of this.dequeueNextRunHistoryMessages()) {
			this.injectMessage(queuedMessage);
		}

		this._state.isStreaming = true;

		const abortController = new AbortController();
		this.abortController = abortController;

		this.emit({ type: "agent_start", continuation: true });

		let aborted = false;
		let lastStopReason: import("./types.js").StopReason | undefined;

		try {
			const transformedMessages = await this.messageTransformer(
				this._state.messages,
			);
			const messagesToSend = normalizeMessagesForProvider(
				transformedMessages,
				this._state.model,
			);
			const continuationPrompt = options?.continuationPrompt?.trim();
			const providerMessages = continuationPrompt
				? [
						...messagesToSend,
						{
							role: "user" as const,
							content: continuationPrompt,
							timestamp: Date.now(),
						},
					]
				: messagesToSend;

			// Determine reasoning level
			const level = this._state.thinkingLevel;
			const reasoning = this._state.model.reasoning
				? mapThinkingLevel(level)
				: undefined;

			// Inject Context from Environment
			let systemPrompt =
				options?.systemPromptOverride ?? this._state.systemPrompt;
			const nextRunSystemPromptAdditions =
				this.dequeueNextRunSystemPromptAdditions();
			if (nextRunSystemPromptAdditions.length > 0) {
				systemPrompt = `${systemPrompt}\n\n${nextRunSystemPromptAdditions.join("\n\n")}`;
			}
			try {
				const contextAdditions =
					await this.contextManager.getCombinedSystemPrompt();
				if (contextAdditions) {
					systemPrompt += `\n\n${contextAdditions}`;
				}
			} catch (error) {
				logger.warn("Failed to inject environmental context", {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			// Create a synthetic continuation trigger message
			// This signals to the transport that we want the model to continue responding
			const continuationMessage: UserMessage = {
				role: "user",
				content: [],
				timestamp: Date.now(),
			};

			const runConfig = {
				systemPrompt,
				tools: this._state.tools,
				model: this._state.model,
				reasoning,
				reasoningSummary: this._state.reasoningSummary,
				preprocessMessages: this.preprocessMessages,
				getSteeringMessages: async <T>() => this.dequeueSteeringMessages<T>(),
				getFollowUpMessages: async <T>() => this.dequeueFollowUpMessages<T>(),
				getPromptOnlyMessages: async () => this.dequeuePromptOnlyMessages(),
				user: this._state.user,
				session: this._state.session,
				sandbox: this._state.sandbox,
				temperature: this._state.temperature,
				topP: this._state.topP,
				emitUserMessageEnd: false,
			};

			for await (const event of this.transport.run(
				providerMessages,
				continuationMessage,
				runConfig,
				abortController.signal,
			)) {
				if (event.type === "message_start") {
					this._state.streamMessage = isCoreMessage(event.message)
						? event.message
						: null;
					this.emit(event);
				} else if (event.type === "message_update") {
					this._state.streamMessage = isCoreMessage(event.message)
						? event.message
						: null;
					this.emit(event);
				} else if (event.type === "message_end") {
					this._state.streamMessage = null;
					const incoming = event.message as AppMessage;
					const lastMessage =
						this._state.messages[this._state.messages.length - 1];
					if (!isDuplicateMessage(lastMessage, incoming)) {
						this._state.messages = [...this._state.messages, incoming];
					}
					// Track last stop reason for overflow detection
					if (
						"stopReason" in event.message &&
						event.message.stopReason !== undefined
					) {
						lastStopReason = event.message.stopReason;
					}
					this.primeToolBatch(incoming);
					this.emit(event);
				} else if (event.type === "tool_execution_start") {
					this.handleToolExecutionStart(event);
				} else if (event.type === "tool_execution_update") {
					this.handleToolExecutionUpdate(event);
				} else if (event.type === "tool_execution_end") {
					this.handleToolExecutionEnd(event);
				} else {
					this.emit(event);
				}
			}
		} catch (error: unknown) {
			if (error instanceof Error && error.name === "AbortError") {
				aborted = true;
			} else {
				this._state.error =
					error instanceof Error ? error.message : String(error);
				throw error;
			}
		} finally {
			this._state.isStreaming = false;
			if (this.abortController === abortController) {
				this.abortController = undefined;
			}
			// Clean up running prompt tracking
			this.resolveRunningPrompt?.();
			this.runningPrompt = undefined;
			this.resolveRunningPrompt = undefined;
			if (this._state.pendingToolCalls.size > 0) {
				const reason = aborted
					? "Error: Operation aborted"
					: "Error: Tool execution did not complete";
				this.resolvePendingToolCalls(reason);
			}

			const partialAccepted = this._partialAccepted;
			this._partialAccepted = null;

			this.emit({
				type: "agent_end",
				messages: this._state.messages,
				aborted,
				partialAccepted: partialAccepted ?? undefined,
				stopReason: lastStopReason,
			});
		}
	}

	private handleToolExecutionStart(
		event: Extract<AgentEvent, { type: "tool_execution_start" }>,
	): void {
		const tool = this._state.tools.find(
			(candidate) => candidate.name === event.toolName,
		);
		const displayName = describeToolDisplayName(
			event.toolName,
			event.args,
			tool,
		);
		const summaryLabel = summarizeToolUse(event.toolName, event.args, tool);
		this._state.pendingToolCalls.set(event.toolCallId, {
			toolName: event.toolName,
			args: event.args,
			tool,
			displayName,
			summaryLabel,
		});
		this.emitStatus(describeToolActivity(event.toolName, event.args, tool), {
			kind: "tool_execution_summary",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			displayName,
			summaryLabel,
		});
		this.emit({ ...event, displayName, summaryLabel });
	}

	private handleToolExecutionUpdate(
		event: Extract<AgentEvent, { type: "tool_execution_update" }>,
	): void {
		const pending = this._state.pendingToolCalls.get(event.toolCallId);
		const tool = pending?.tool;
		const displayName =
			describeToolDisplayName(event.toolName, event.args, tool) ??
			pending?.displayName;
		const summaryLabel =
			summarizeToolUse(event.toolName, event.args, tool) ??
			pending?.summaryLabel;
		if (pending) {
			pending.args = event.args;
			pending.displayName = displayName;
			pending.summaryLabel = summaryLabel;
		}
		this.emit({ ...event, displayName, summaryLabel });
	}

	private handleToolExecutionEnd(
		event: Extract<AgentEvent, { type: "tool_execution_end" }>,
	): void {
		const pending = this._state.pendingToolCalls.get(event.toolCallId);
		this._state.pendingToolCalls.delete(event.toolCallId);
		this.emit({
			...event,
			displayName: pending?.displayName,
			summaryLabel: pending?.summaryLabel,
		});
		if (!pending) {
			return;
		}
		this.completedToolBatch.push({
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: pending.args ?? {},
			isError: event.isError,
			tool: pending.tool,
		});
		if (this.activeToolBatchIds?.delete(event.toolCallId)) {
			if (this.activeToolBatchIds.size > 0) {
				return;
			}
			this.activeToolBatchIds = null;
			this.emitToolBatchSummary();
		}
	}

	private primeToolBatch(message: AppMessage): void {
		if (message.role !== "assistant" || message.stopReason !== "toolUse") {
			return;
		}
		const toolCallIds = message.content.flatMap((block) =>
			block.type === "toolCall" ? [block.id] : [],
		);
		if (toolCallIds.length === 0) {
			this.activeToolBatchIds = null;
			this.completedToolBatch = [];
			return;
		}
		this.activeToolBatchIds = new Set(toolCallIds);
		this.completedToolBatch = [];
	}

	private emitToolBatchSummary(): void {
		if (this.completedToolBatch.length === 0) {
			return;
		}
		const batch = this.completedToolBatch;
		this.completedToolBatch = [];
		const { summary, summaryLabels, callsSucceeded, callsFailed } =
			summarizeToolBatch(batch);
		this.emit({
			type: "tool_batch_summary",
			summary,
			summaryLabels,
			toolCallIds: batch.map((entry) => entry.toolCallId),
			toolNames: batch.map((entry) => entry.toolName),
			callsSucceeded,
			callsFailed,
		});
		if (summaryLabels.length > 0) {
			this.promptOnlyQueue.push(
				buildPromptOnlyToolBatchSummaryMessage(summaryLabels),
			);
		}
	}

	private resolvePendingToolCalls(reason: string): void {
		for (const [toolCallId, info] of this._state.pendingToolCalls.entries()) {
			const abortedResult: ToolResultMessage = {
				role: "toolResult",
				toolCallId,
				toolName: info.toolName,
				content: [
					{
						type: "text",
						text: reason,
					},
				],
				isError: true,
				timestamp: Date.now(),
			};
			this._state.messages = [...this._state.messages, abortedResult];
			this.handleToolExecutionEnd({
				type: "tool_execution_end",
				toolCallId,
				toolName: info.toolName,
				result: abortedResult,
				isError: true,
			});
		}
		this._state.pendingToolCalls.clear();
	}

	async generateSummary(
		history: Message[],
		prompt: string,
		systemPrompt = "",
		modelOverride?: Model<Api>,
		signal?: AbortSignal,
	): Promise<AssistantMessage> {
		const summaryModel = modelOverride ?? this._state.model;
		if (!summaryModel) {
			throw new Error("No model configured for summarization");
		}

		const userMessage: UserMessage = {
			role: "user",
			content: [{ type: "text", text: prompt }],
			timestamp: Date.now(),
		};

		const runMessages: Message[] = [...history, userMessage];
		const runConfig = {
			systemPrompt,
			tools: [],
			model: summaryModel,
			reasoning: undefined,
			// Keep summary generation fast by not requesting reasoning summaries.
			reasoningSummary: undefined,
			preprocessMessages: this.preprocessMessages,
		};

		const controller = new AbortController();
		if (signal) {
			if (signal.aborted) {
				controller.abort(signal.reason);
			} else {
				signal.addEventListener(
					"abort",
					() => {
						controller.abort(signal.reason);
					},
					{ once: true },
				);
			}
		}
		let finalMessage: AssistantMessage | null = null;

		try {
			for await (const event of this.transport.run(
				runMessages,
				userMessage,
				runConfig,
				controller.signal,
			)) {
				if (
					event.type === "message_end" &&
					event.message.role === "assistant"
				) {
					finalMessage = event.message as AssistantMessage;
				}
			}
		} finally {
			controller.abort();
		}

		if (!finalMessage) {
			throw new Error("Summary generation did not return a response");
		}

		return finalMessage;
	}
}
