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
import {
	buildDiagnosticRepairFollowUpMessage,
	getDiagnosticDeltaFromToolResult,
	hasDiagnosticRepairOptOut,
} from "../lsp/diagnostic-repair.js";
import type { SkillArtifactMetadata } from "../skills/artifact-metadata.js";
import {
	recordMaestroEvalScored,
	recordMaestroSkillInvoked,
	recordMaestroSkillOutcome,
	recordMaestroToolCallAttempt,
	recordMaestroToolCallCompleted,
} from "../telemetry/maestro-event-bus.js";
import { createQueryProfilerFromEnv } from "../utils/checkpoint-profiler.js";
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
import { isContextOverflow as isAssistantContextOverflow } from "./context-overflow.js";
import { convertAppMessagesToLlm, isCoreMessage } from "./custom-messages.js";
import {
	type PreprocessMessagesFn,
	chainPreprocessMessages,
	defaultPreprocessMessages,
} from "./preprocess-messages.js";
import { isAssistantMessage } from "./type-guards.js";
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
	StopReason,
	TextContent,
	ThinkingLevel,
	ToolResultMessage,
	Usage,
	UserMessage,
	UserMessageWithAttachments,
} from "./types.js";

const logger = createLogger("agent");

type ToolEvaluationSummary = {
	score?: number;
	threshold?: number;
	passed?: boolean;
	rationale?: string;
	assertionCount?: number;
};

function getToolEvaluationSummary(
	details: unknown,
): ToolEvaluationSummary | undefined {
	if (!details || typeof details !== "object" || Array.isArray(details)) {
		return undefined;
	}

	const normalized = details as {
		evaluation?: unknown;
		assertions?: unknown;
	};
	if (
		!normalized.evaluation ||
		typeof normalized.evaluation !== "object" ||
		Array.isArray(normalized.evaluation)
	) {
		return undefined;
	}

	const evaluation = normalized.evaluation as Record<string, unknown>;
	const summary: ToolEvaluationSummary = {};
	if (
		typeof evaluation.score === "number" &&
		Number.isFinite(evaluation.score)
	) {
		summary.score = evaluation.score;
	}
	if (
		typeof evaluation.threshold === "number" &&
		Number.isFinite(evaluation.threshold)
	) {
		summary.threshold = evaluation.threshold;
	}
	if (typeof evaluation.passed === "boolean") {
		summary.passed = evaluation.passed;
	}
	if (
		typeof evaluation.rationale === "string" &&
		evaluation.rationale.trim().length > 0
	) {
		summary.rationale = evaluation.rationale.trim();
	}
	if (
		Array.isArray(normalized.assertions) &&
		normalized.assertions.length > 0
	) {
		summary.assertionCount = normalized.assertions.length;
	}

	return Object.keys(summary).length > 0 ? summary : undefined;
}

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
	const normalizedMessages: Message[] = [];

	for (const msg of messages) {
		if (msg.role !== "assistant") {
			if (msg.role === "user") {
				const previous = normalizedMessages[normalizedMessages.length - 1];
				if (previous?.role === "user") {
					const previousContent: (TextContent | ImageContent)[] =
						typeof previous.content === "string"
							? [{ type: "text", text: previous.content }]
							: [...previous.content];
					const currentContent: (TextContent | ImageContent)[] =
						typeof msg.content === "string"
							? [{ type: "text", text: msg.content }]
							: [...msg.content];
					const mergedContent: (TextContent | ImageContent)[] =
						previousContent.length > 0 && currentContent.length > 0
							? [
									...previousContent,
									{ type: "text", text: "\n\n" } as TextContent,
									...currentContent,
								]
							: [...previousContent, ...currentContent];
					const previousAttachments = (
						"attachments" in previous ? previous.attachments : undefined
					) as Attachment[] | undefined;
					const currentAttachments = (
						"attachments" in msg ? msg.attachments : undefined
					) as Attachment[] | undefined;
					const mergedAttachments: Attachment[] = [
						...(previousAttachments ?? []),
						...(currentAttachments ?? []),
					];
					const mergedUser: UserMessageWithAttachments = {
						...previous,
						content: mergedContent,
						attachments:
							mergedAttachments.length > 0 ? mergedAttachments : undefined,
						metadata: previous.metadata ?? msg.metadata,
					};
					normalizedMessages[normalizedMessages.length - 1] = mergedUser;
					continue;
				}
			}
			normalizedMessages.push(msg);
			continue;
		}
		const shouldConvertThinking =
			msg.provider !== targetModel.provider ||
			msg.api !== targetModel.api ||
			!targetModel.reasoning;
		if (!shouldConvertThinking) {
			normalizedMessages.push(msg);
			continue;
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
		normalizedMessages.push({ ...msg, content });
	}

	return normalizedMessages;
}

type BufferedAssistantStartState = {
	pendingAssistantStart: AssistantMessage | null;
	lastStopReason?: StopReason;
};

type StreamedMessageEvent = Extract<
	AgentEvent,
	{ type: "message_start" | "message_update" | "message_end" }
>;

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

function mergeUsage(messages: AssistantMessage[]): Usage {
	return messages.reduce<Usage>(
		(acc, message) => ({
			input: acc.input + message.usage.input,
			output: acc.output + message.usage.output,
			cacheRead: acc.cacheRead + message.usage.cacheRead,
			cacheWrite: acc.cacheWrite + message.usage.cacheWrite,
			cost: {
				input: acc.cost.input + message.usage.cost.input,
				output: acc.cost.output + message.usage.cost.output,
				cacheRead: acc.cost.cacheRead + message.usage.cost.cacheRead,
				cacheWrite: acc.cost.cacheWrite + message.usage.cost.cacheWrite,
				total: acc.cost.total + message.usage.cost.total,
			},
		}),
		{
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
	);
}

function mergeAssistantMessages(
	messages: AssistantMessage[],
): AssistantMessage {
	const lastMessage = messages[messages.length - 1]!;
	return {
		...lastMessage,
		content: messages.flatMap((message) => message.content),
		usage: mergeUsage(messages),
	};
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
	private defaultTaskBudgetTotal?: number;
	private currentTaskBudget?:
		| {
				total: number;
				remaining?: number;
		  }
		| undefined;
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
	private suppressRecoverableOverflowErrors = false;
	private withheldRecoverableOverflowError?: AssistantMessage;
	private withheldRecoverableLengthMessages: AssistantMessage[] = [];
	private pendingMergedRecoverableTurnEnd?: AssistantMessage;
	private diagnosticRepairAttempts = new Map<string, number>();
	private currentTurnSkillSelections = new Map<
		string,
		{
			skillMetadata: SkillArtifactMetadata;
			toolCallId: string;
			toolExecutionId?: string;
		}
	>();

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

	setTaskBudgetTotal(total: number | undefined): void {
		this.defaultTaskBudgetTotal = total;
	}

	getTaskBudgetTotal(): number | undefined {
		return this.defaultTaskBudgetTotal;
	}

	setCurrentTaskBudget(
		taskBudget:
			| {
					total: number;
					remaining?: number;
			  }
			| undefined,
	): void {
		this.currentTaskBudget = taskBudget ? { ...taskBudget } : undefined;
	}

	getCurrentTaskBudget():
		| {
				total: number;
				remaining?: number;
		  }
		| undefined {
		return this.currentTaskBudget ? { ...this.currentTaskBudget } : undefined;
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
	clearTransientRunState(options?: {
		clearSessionContextCache?: boolean;
	}): void {
		this._state.isStreaming = false;
		this._state.streamMessage = null;
		this._state.pendingToolCalls.clear();
		if (options?.clearSessionContextCache) {
			this.contextManager.clearSessionCache();
		}
		this.activeToolBatchIds = null;
		this.completedToolBatch = [];
		this.promptOnlyQueue = [];
		this._state.error = undefined;
		this.withheldRecoverableOverflowError = undefined;
		this.pendingMergedRecoverableTurnEnd = undefined;
		if (!this.suppressRecoverableOverflowErrors) {
			this.withheldRecoverableLengthMessages = [];
		}
		this._partialAccepted = null;
		this.currentTurnSkillSelections.clear();
	}

	setRecoverableOverflowErrorSuppression(enabled: boolean): void {
		this.suppressRecoverableOverflowErrors = enabled;
		if (!enabled) {
			this.withheldRecoverableOverflowError = undefined;
			this.withheldRecoverableLengthMessages = [];
			this.pendingMergedRecoverableTurnEnd = undefined;
		}
	}

	getWithheldRecoverableOverflowError(): AssistantMessage | undefined {
		return this.withheldRecoverableOverflowError;
	}

	flushWithheldRecoverableLengthMessage(): AssistantMessage | undefined {
		if (this.withheldRecoverableLengthMessages.length === 0) {
			return undefined;
		}

		const merged = mergeAssistantMessages(
			this.withheldRecoverableLengthMessages,
		);
		this._state.messages = [
			...this._state.messages.slice(
				0,
				-this.withheldRecoverableLengthMessages.length,
			),
			merged,
		];
		this.withheldRecoverableLengthMessages = [];
		this.pendingMergedRecoverableTurnEnd = undefined;
		this.primeToolBatch(merged);
		this.emit({ type: "message_start", message: merged });
		this.emit({ type: "message_end", message: merged });
		this.emit({ type: "turn_end", message: merged, toolResults: [] });
		return merged;
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

	private shouldWithholdRecoverableOverflowError(
		message: AppMessage,
	): message is AssistantMessage {
		return (
			this.suppressRecoverableOverflowErrors &&
			isAssistantMessage(message) &&
			message.stopReason === "error" &&
			isAssistantContextOverflow(message, this._state.model.contextWindow)
		);
	}

	private shouldWithholdRecoverableMaxOutput(
		message: AssistantMessage,
	): boolean {
		return (
			this.suppressRecoverableOverflowErrors && message.stopReason === "length"
		);
	}

	private shouldMergeRecoverableLengthContinuation(
		message: AssistantMessage,
	): boolean {
		return (
			this.suppressRecoverableOverflowErrors &&
			this.withheldRecoverableLengthMessages.length > 0 &&
			message.stopReason !== "length" &&
			message.stopReason !== "error"
		);
	}

	private mergeWithWithheldRecoverableLengthMessages(
		incoming: AssistantMessage,
	): AssistantMessage {
		if (this.withheldRecoverableLengthMessages.length === 0) {
			return incoming;
		}

		const merged = mergeAssistantMessages([
			...this.withheldRecoverableLengthMessages,
			incoming,
		]);
		this._state.messages = [
			...this._state.messages.slice(
				0,
				-this.withheldRecoverableLengthMessages.length,
			),
			merged,
		];
		this.withheldRecoverableLengthMessages = [];
		this.pendingMergedRecoverableTurnEnd = merged;
		return merged;
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
	 * Clear queued one-shot prompt inputs that were prepared for the next run but
	 * not yet consumed.
	 */
	clearQueuedPromptInputs(): void {
		this.nextRunHistoryQueue = [];
		this.nextRunPromptOnlyQueue = [];
		this.promptOnlyQueue = [];
		this.nextRunSystemPromptAdditions = [];
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
		this.withheldRecoverableOverflowError = undefined;
		this.withheldRecoverableLengthMessages = [];
		this.pendingMergedRecoverableTurnEnd = undefined;
		this.currentTaskBudget = undefined;
		this.diagnosticRepairAttempts.clear();
		this.currentTurnSkillSelections.clear();
		// Note: Do NOT clear listeners - they contain the TUI subscription
		// and must persist across resets for UI updates to work
	}

	private buildProviderMessages(
		transformedMessages: Message[],
		continuationPrompt?: string,
	): Message[] {
		const providerInputMessages = continuationPrompt
			? [
					...transformedMessages,
					{
						role: "user" as const,
						content: continuationPrompt,
						timestamp: Date.now(),
					},
				]
			: transformedMessages;
		return normalizeMessagesForProvider(
			providerInputMessages,
			this._state.model,
		);
	}

	private handleStreamedMessageEvent(
		event: StreamedMessageEvent,
		state: BufferedAssistantStartState,
	): BufferedAssistantStartState {
		let { pendingAssistantStart, lastStopReason } = state;

		if (event.type === "message_start") {
			if (
				this.suppressRecoverableOverflowErrors &&
				isAssistantMessage(event.message)
			) {
				pendingAssistantStart = event.message;
				this._state.streamMessage = isCoreMessage(event.message)
					? event.message
					: null;
				if (
					this.shouldWithholdRecoverableOverflowError(
						event.message as AppMessage,
					) ||
					this.shouldWithholdRecoverableMaxOutput(event.message) ||
					this.shouldMergeRecoverableLengthContinuation(event.message)
				) {
					this._state.streamMessage = null;
					pendingAssistantStart = null;
				}
				return { pendingAssistantStart, lastStopReason };
			}
			if (
				this.shouldWithholdRecoverableOverflowError(
					event.message as AppMessage,
				) ||
				(isAssistantMessage(event.message) &&
					(this.shouldWithholdRecoverableMaxOutput(event.message) ||
						this.shouldMergeRecoverableLengthContinuation(event.message)))
			) {
				this._state.streamMessage = null;
				return { pendingAssistantStart, lastStopReason };
			}
			this._state.streamMessage = isCoreMessage(event.message)
				? event.message
				: null;
			this.emit(event);
			return { pendingAssistantStart, lastStopReason };
		}

		if (event.type === "message_update") {
			if (
				this.shouldWithholdRecoverableOverflowError(
					event.message as AppMessage,
				) ||
				(isAssistantMessage(event.message) &&
					(this.shouldWithholdRecoverableMaxOutput(event.message) ||
						this.shouldMergeRecoverableLengthContinuation(event.message)))
			) {
				this._state.streamMessage = null;
				pendingAssistantStart = null;
				return { pendingAssistantStart, lastStopReason };
			}
			if (pendingAssistantStart) {
				this.emit({
					type: "message_start",
					message: pendingAssistantStart,
				});
				pendingAssistantStart = null;
			}
			this._state.streamMessage = isCoreMessage(event.message)
				? event.message
				: null;
			this.emit(event);
			return { pendingAssistantStart, lastStopReason };
		}

		this._state.streamMessage = null;
		let incoming = event.message as AppMessage;
		if (this.shouldWithholdRecoverableOverflowError(incoming)) {
			pendingAssistantStart = null;
			this.withheldRecoverableOverflowError = incoming;
			lastStopReason = incoming.stopReason;
			return { pendingAssistantStart, lastStopReason };
		}
		if (
			isAssistantMessage(incoming) &&
			this.shouldWithholdRecoverableMaxOutput(incoming)
		) {
			pendingAssistantStart = null;
			const assistantIncoming = incoming;
			const lastMessage = this._state.messages[this._state.messages.length - 1];
			if (!isDuplicateMessage(lastMessage, assistantIncoming)) {
				this._state.messages = [...this._state.messages, assistantIncoming];
				this.withheldRecoverableLengthMessages.push(assistantIncoming);
			}
			lastStopReason = "length";
			return { pendingAssistantStart, lastStopReason };
		}
		if (
			isAssistantMessage(incoming) &&
			this.shouldMergeRecoverableLengthContinuation(incoming)
		) {
			pendingAssistantStart = null;
			incoming = this.mergeWithWithheldRecoverableLengthMessages(incoming);
			lastStopReason = incoming.stopReason;
			this.primeToolBatch(incoming);
			this.emit({ type: "message_start", message: incoming });
			this.emit({ ...event, message: incoming });
			return { pendingAssistantStart, lastStopReason };
		}
		if (pendingAssistantStart && isAssistantMessage(incoming)) {
			this.emit({
				type: "message_start",
				message: pendingAssistantStart,
			});
			pendingAssistantStart = null;
		}
		const lastMessage = this._state.messages[this._state.messages.length - 1];
		if (!isDuplicateMessage(lastMessage, incoming)) {
			this._state.messages = [...this._state.messages, incoming];
		}
		if (
			"stopReason" in event.message &&
			event.message.stopReason !== undefined
		) {
			lastStopReason = event.message.stopReason;
		}
		this.primeToolBatch(incoming);
		this.emit({ ...event, message: incoming });
		return { pendingAssistantStart, lastStopReason };
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

		const queryProfiler = createQueryProfilerFromEnv();
		queryProfiler.checkpoint("input:received");

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
		let lastStopReason: StopReason | undefined;
		let pendingAssistantStart: AssistantMessage | null = null;

		try {
			const transformedMessages = await this.messageTransformer(
				this._state.messages,
			);
			const messagesToSend = this.buildProviderMessages(transformedMessages);
			queryProfiler.checkpoint("context:loaded", {
				messages: messagesToSend.length,
			});

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
			queryProfiler.checkpoint("prompt:assembled", {
				system_bytes: systemPrompt.length,
			});

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
				taskBudget: this.currentTaskBudget,
				queryProfiler,
			};
			queryProfiler.checkpoint("tools:prepared", {
				tools: this._state.tools.length,
			});

			for await (const event of this.transport.run(
				messagesToSend, // Include userMessage in messages array
				userMessage,
				runConfig,
				abortController.signal,
			)) {
				if (
					event.type === "message_start" ||
					event.type === "message_update" ||
					event.type === "message_end"
				) {
					({ pendingAssistantStart, lastStopReason } =
						this.handleStreamedMessageEvent(event, {
							pendingAssistantStart,
							lastStopReason,
						}));
				} else if (event.type === "tool_execution_start") {
					this.handleToolExecutionStart(event);
				} else if (event.type === "tool_execution_update") {
					this.handleToolExecutionUpdate(event);
				} else if (event.type === "tool_execution_end") {
					this.handleToolExecutionEnd(event);
				} else if (event.type === "turn_end") {
					if (
						this.shouldWithholdRecoverableOverflowError(
							event.message as AppMessage,
						) ||
						(isAssistantMessage(event.message) &&
							this.shouldWithholdRecoverableMaxOutput(event.message))
					) {
						continue;
					}
					if (this.pendingMergedRecoverableTurnEnd) {
						this.emit({
							...event,
							message: this.pendingMergedRecoverableTurnEnd,
						});
						this.pendingMergedRecoverableTurnEnd = undefined;
						continue;
					}
					this.emit(event);
				} else {
					this.emit(event);
				}
			}
		} catch (error: unknown) {
			if (error instanceof Error && error.name === "AbortError") {
				aborted = true;
				queryProfiler.terminal("turn:aborted");
			} else {
				this._state.error =
					error instanceof Error ? error.message : String(error);
				queryProfiler.terminal("turn:error");
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
			this.publishCurrentTurnSkillOutcomes({
				aborted,
				stopReason: lastStopReason,
			});

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
		/** Override max output tokens for this continuation only. */
		maxTokensOverride?: number;
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

		const queryProfiler = createQueryProfilerFromEnv();
		queryProfiler.checkpoint("input:received", { continuation: true });

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
		let lastStopReason: StopReason | undefined;
		let pendingAssistantStart: AssistantMessage | null = null;

		try {
			const transformedMessages = await this.messageTransformer(
				this._state.messages,
			);
			const continuationPrompt = options?.continuationPrompt?.trim();
			const providerMessages = this.buildProviderMessages(
				transformedMessages,
				continuationPrompt,
			);
			queryProfiler.checkpoint("context:loaded", {
				messages: providerMessages.length,
			});

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
			queryProfiler.checkpoint("prompt:assembled", {
				system_bytes: systemPrompt.length,
			});

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
				model:
					options?.maxTokensOverride !== undefined
						? {
								...this._state.model,
								maxTokens: options.maxTokensOverride,
							}
						: this._state.model,
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
				taskBudget: this.currentTaskBudget,
				emitUserMessageEnd: false,
				queryProfiler,
			};
			queryProfiler.checkpoint("tools:prepared", {
				tools: this._state.tools.length,
			});

			for await (const event of this.transport.run(
				providerMessages,
				continuationMessage,
				runConfig,
				abortController.signal,
			)) {
				if (
					event.type === "message_start" ||
					event.type === "message_update" ||
					event.type === "message_end"
				) {
					({ pendingAssistantStart, lastStopReason } =
						this.handleStreamedMessageEvent(event, {
							pendingAssistantStart,
							lastStopReason,
						}));
				} else if (event.type === "tool_execution_start") {
					this.handleToolExecutionStart(event);
				} else if (event.type === "tool_execution_update") {
					this.handleToolExecutionUpdate(event);
				} else if (event.type === "tool_execution_end") {
					this.handleToolExecutionEnd(event);
				} else if (event.type === "turn_end") {
					if (
						this.shouldWithholdRecoverableOverflowError(
							event.message as AppMessage,
						) ||
						(isAssistantMessage(event.message) &&
							this.shouldWithholdRecoverableMaxOutput(event.message))
					) {
						continue;
					}
					if (this.pendingMergedRecoverableTurnEnd) {
						this.emit({
							...event,
							message: this.pendingMergedRecoverableTurnEnd,
						});
						this.pendingMergedRecoverableTurnEnd = undefined;
						continue;
					}
					this.emit(event);
				} else {
					this.emit(event);
				}
			}
		} catch (error: unknown) {
			if (error instanceof Error && error.name === "AbortError") {
				aborted = true;
				queryProfiler.terminal("turn:aborted");
			} else {
				this._state.error =
					error instanceof Error ? error.message : String(error);
				queryProfiler.terminal("turn:error");
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
			this.publishCurrentTurnSkillOutcomes({
				aborted,
				stopReason: lastStopReason,
			});

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
		recordMaestroToolCallAttempt({
			tool_call_id: event.toolCallId,
			tool_execution_id: event.toolExecutionId,
			prompt_metadata: this._state.promptMetadata,
			tool_name: event.toolName,
			safe_arguments: event.args,
			correlation: {
				session_id: this._state.session?.id,
				agent_run_step_id: event.toolCallId,
			},
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

	private preserveSpecificPendingToolLabel(
		nextLabel: string,
		pendingLabel: string | undefined,
		genericLabel: string,
	): string {
		if (
			!pendingLabel ||
			pendingLabel === genericLabel ||
			nextLabel !== genericLabel
		) {
			return nextLabel;
		}
		return pendingLabel;
	}

	private handleToolExecutionUpdate(
		event: Extract<AgentEvent, { type: "tool_execution_update" }>,
	): void {
		const pending = this._state.pendingToolCalls.get(event.toolCallId);
		const tool = pending?.tool;
		const nextDisplayName = describeToolDisplayName(
			event.toolName,
			event.args,
			tool,
		);
		const nextSummaryLabel = summarizeToolUse(event.toolName, event.args, tool);
		const displayName = this.preserveSpecificPendingToolLabel(
			nextDisplayName,
			pending?.displayName,
			describeToolDisplayName(event.toolName, {}, tool),
		);
		const summaryLabel = this.preserveSpecificPendingToolLabel(
			nextSummaryLabel,
			pending?.summaryLabel,
			summarizeToolUse(event.toolName, {}, tool),
		);
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
		recordMaestroToolCallCompleted({
			tool_call_id: event.toolCallId,
			tool_execution_id: event.toolExecutionId,
			prompt_metadata: this._state.promptMetadata,
			status: event.isError
				? "MAESTRO_TOOL_CALL_STATUS_FAILED"
				: "MAESTRO_TOOL_CALL_STATUS_SUCCEEDED",
			skill_metadata: event.skillMetadata,
			approval_request_id: event.approvalRequestId,
			governed_outcome: event.governedOutcome,
			error_code: event.errorCode,
			error_message: event.isError
				? event.result.content
						.map((part) => (part.type === "text" ? part.text : ""))
						.filter(Boolean)
						.join("\n")
				: undefined,
			correlation: {
				session_id: this._state.session?.id,
				agent_run_step_id: event.toolCallId,
			},
		});
		if (event.skillMetadata) {
			this.recordCurrentTurnSkillSelection({
				skillMetadata: event.skillMetadata,
				toolCallId: event.toolCallId,
				toolExecutionId: event.toolExecutionId,
			});
			if (event.toolName === "Skill") {
				recordMaestroSkillInvoked({
					prompt_metadata: this._state.promptMetadata,
					skill_metadata: event.skillMetadata,
					tool_call_id: event.toolCallId,
					tool_execution_id: event.toolExecutionId,
					correlation: {
						session_id: this._state.session?.id,
						agent_run_step_id: event.toolCallId,
					},
					invoked_at: new Date(event.result.timestamp).toISOString(),
				});
			}
		}
		this.publishCurrentTurnEvalScores(event);
		this.handleDiagnosticDeltaToolResult(event);
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

	private buildSkillSelectionKey(skillMetadata: SkillArtifactMetadata): string {
		return [
			skillMetadata.artifactId,
			skillMetadata.source,
			skillMetadata.name,
			skillMetadata.version,
			skillMetadata.hash,
		]
			.filter(Boolean)
			.join(":");
	}

	private recordCurrentTurnSkillSelection(selection: {
		skillMetadata: SkillArtifactMetadata;
		toolCallId: string;
		toolExecutionId?: string;
	}): void {
		const key = this.buildSkillSelectionKey(selection.skillMetadata);
		if (!key) {
			return;
		}
		this.currentTurnSkillSelections.set(key, selection);
	}

	private publishCurrentTurnEvalScores(
		event: Extract<AgentEvent, { type: "tool_execution_end" }>,
	): void {
		const evaluation = getToolEvaluationSummary(event.result.details);
		if (!evaluation || this.currentTurnSkillSelections.size === 0) {
			return;
		}

		const scoredAt = new Date(event.result.timestamp).toISOString();
		for (const selection of this.currentTurnSkillSelections.values()) {
			recordMaestroEvalScored({
				prompt_metadata: this._state.promptMetadata,
				skill_metadata: selection.skillMetadata,
				tool_call_id: event.toolCallId,
				tool_execution_id: event.toolExecutionId,
				tool_name: event.toolName,
				score: evaluation.score,
				threshold: evaluation.threshold,
				passed: evaluation.passed,
				rationale: evaluation.rationale,
				assertion_count: evaluation.assertionCount,
				correlation: {
					session_id: this._state.session?.id,
					agent_run_step_id: event.toolCallId,
				},
				scored_at: scoredAt,
			});
		}
	}

	private publishCurrentTurnSkillOutcomes(options: {
		aborted: boolean;
		stopReason?: StopReason;
	}): void {
		if (this.currentTurnSkillSelections.size === 0) {
			return;
		}

		const turnStatus = options.aborted
			? "aborted"
			: this._state.error
				? "error"
				: "success";
		const errorMessage = options.aborted
			? "Operation aborted"
			: this._state.error;

		for (const selection of this.currentTurnSkillSelections.values()) {
			recordMaestroSkillOutcome({
				prompt_metadata: this._state.promptMetadata,
				skill_metadata: selection.skillMetadata,
				tool_call_id: selection.toolCallId,
				tool_execution_id: selection.toolExecutionId,
				turn_status: turnStatus,
				error_category: turnStatus === "success" ? undefined : "runtime",
				error_message: turnStatus === "success" ? undefined : errorMessage,
				stop_reason: options.stopReason,
				correlation: {
					session_id: this._state.session?.id,
				},
			});
		}

		this.currentTurnSkillSelections.clear();
	}

	private handleDiagnosticDeltaToolResult(
		event: Extract<AgentEvent, { type: "tool_execution_end" }>,
	): void {
		const summary = getDiagnosticDeltaFromToolResult(event.result);
		if (!summary) {
			return;
		}
		if (summary.introducedCount === 0 && summary.repairedCount === 0) {
			return;
		}

		const repairKey = [event.toolName, summary.file, summary.fingerprint].join(
			":",
		);
		const nextAttempt = (this.diagnosticRepairAttempts.get(repairKey) ?? 0) + 1;
		const hasPendingUserInput =
			this.steeringQueue.length > 0 || this.followUpQueue.length > 0;
		const hasOptOut = hasDiagnosticRepairOptOut(this._state.messages);
		const canAutoFollowUp =
			!event.isError &&
			summary.repair.shouldFollowUp &&
			!hasPendingUserInput &&
			!hasOptOut &&
			nextAttempt <= summary.repair.maxAttempts;

		const reason = !summary.repair.shouldFollowUp
			? summary.repair.reason
			: event.isError
				? "Tool call failed; leaving diagnostics in the tool result."
				: hasPendingUserInput
					? "Queued user input exists; not adding an automatic diagnostic repair turn."
					: hasOptOut
						? "User asked Maestro not to continue or repair automatically."
						: nextAttempt > summary.repair.maxAttempts
							? "Automatic diagnostic repair attempt limit reached."
							: "Queued a bounded diagnostic repair follow-up.";

		if (summary.repair.shouldFollowUp) {
			this.diagnosticRepairAttempts.set(repairKey, nextAttempt);
		}

		this.emit({
			type: "diagnostic_delta",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			file: summary.file,
			displayPath: summary.displayPath,
			usedDelta: summary.usedDelta,
			introducedCount: summary.introducedCount,
			repairedCount: summary.repairedCount,
			remainingCount: summary.remainingCount,
			fingerprint: summary.fingerprint,
			repairAttempt: summary.repair.shouldFollowUp ? nextAttempt : undefined,
			maxRepairAttempts: summary.repair.shouldFollowUp
				? summary.repair.maxAttempts
				: undefined,
			willAutoFollowUp: canAutoFollowUp,
			reason,
		});

		if (!canAutoFollowUp) {
			return;
		}

		this.enqueueFollowUpMessageSync(
			buildDiagnosticRepairFollowUpMessage({
				summary,
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				attempt: nextAttempt,
			}),
			"front",
		);
	}

	private enqueueFollowUpMessageSync(
		message: AppMessage,
		position: "front" | "back" = "back",
	): void {
		const queued: QueuedMessage<AppMessage> = {
			id: this.nextQueuedMessageId++,
			createdAt: Date.now(),
			original: message,
			llm: message as Message,
		};
		if (position === "front") {
			this.followUpQueue.unshift(queued);
			return;
		}
		this.followUpQueue.push(queued);
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
		const providerMessages = normalizeMessagesForProvider(
			runMessages,
			summaryModel,
		);
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
				providerMessages,
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
