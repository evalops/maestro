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

function defaultMessageTransformer(messages: AppMessage[]): Message[] {
	return messages
		.filter(
			(m) =>
				m.role === "user" || m.role === "assistant" || m.role === "toolResult",
		)
		.map((message) => {
			if (message.role !== "user") {
				return message as Message;
			}

			const { attachments, ...rest } = message as UserMessageWithAttachments;
			if (!attachments || attachments.length === 0) {
				return rest as Message;
			}

			const content: Array<TextContent | ImageContent> = Array.isArray(
				rest.content,
			)
				? [...rest.content]
				: [{ type: "text", text: rest.content }];
			for (const attachment of attachments) {
				if (attachment.type === "image") {
					content.push({
						type: "image",
						data: attachment.content,
						mimeType: attachment.mimeType,
					} as ImageContent);
				} else if (attachment.type === "document" && attachment.extractedText) {
					content.push({
						type: "text",
						text: `\n\n[Document: ${attachment.fileName}]\n${attachment.extractedText}`,
					} as TextContent);
				}
			}

			return { ...rest, content } as Message;
		});
}

function mapThinkingLevel(level: ThinkingLevel): ReasoningEffort | undefined {
	switch (level) {
		case "off":
			return undefined;
		case "minimal":
			return "minimal";
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
		case "max":
			return "high";
		default:
			return undefined;
	}
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
	private messageQueue: Array<QueuedMessage<AppMessage>> = [];
	private runningPrompt?: Promise<void>;
	private resolveRunningPrompt?: () => void;

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

		const { systemPrompt, model, thinkingLevel, tools, ...restInitialState } =
			opts.initialState ?? {};

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
			...restInitialState,
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
				console.error("Error in agent event listener:", error);
			}
		}
	}

	private async dequeueQueuedMessages<T>(): Promise<QueuedMessage<T>[]> {
		if (this.messageQueue.length === 0) {
			return [];
		}
		const queued = this.messageQueue.splice(0);
		return queued as unknown as QueuedMessage<T>[];
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
	 * Sets the available tools that the model can invoke.
	 *
	 * @param t - Array of tool definitions with schemas and execute functions
	 */
	setTools(t: AgentTool[]): void {
		this._state.tools = t;
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
	 * Appends a single message to the conversation history.
	 *
	 * @param m - Message to append
	 */
	appendMessage(m: AppMessage): void {
		this._state.messages = [...this._state.messages, m];
	}

	/**
	 * Queues a message for later processing.
	 *
	 * @param m - Message to queue
	 */
	async queueMessage(m: AppMessage): Promise<void> {
		const transformed = await this.messageTransformer([m]);
		this.messageQueue.push({
			original: m,
			llm: transformed[0],
		});
	}

	/**
	 * Clears all messages from the conversation history.
	 */
	clearMessages(): void {
		this._state.messages = [];
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
		this._state.error = undefined;
		this.messageQueue = [];
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

		// Set up running prompt tracking
		this.runningPrompt = new Promise<void>((resolve) => {
			this.resolveRunningPrompt = resolve;
		});

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

		try {
			const messagesToSend = await this.messageTransformer(
				this._state.messages,
			);

			// Determine reasoning level
			const level = this._state.thinkingLevel;
			const reasoning = this._state.model.reasoning
				? mapThinkingLevel(level)
				: undefined;

			const runConfig = {
				systemPrompt: this._state.systemPrompt,
				tools: this._state.tools,
				model: this._state.model,
				reasoning,
				getQueuedMessages: async <T>() => this.dequeueQueuedMessages<T>(),
			};

			for await (const event of this.transport.run(
				messagesToSend, // Include userMessage in messages array
				userMessage,
				runConfig,
				abortController.signal,
			)) {
				if (event.type === "message_start") {
					this._state.streamMessage = event.message;
					this.emit(event);
				} else if (event.type === "message_update") {
					this._state.streamMessage = event.message;
					this.emit(event);
				} else if (event.type === "message_end") {
					this._state.streamMessage = null;
					this._state.messages = [...this._state.messages, event.message];
					this.emit(event);
				} else if (event.type === "tool_execution_start") {
					this._state.pendingToolCalls.set(event.toolCallId, {
						toolName: event.toolName,
					});
					this.emit(event);
				} else if (event.type === "tool_execution_end") {
					this._state.pendingToolCalls.delete(event.toolCallId);
					this.emit(event);
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

			this.emit({
				type: "agent_end",
				messages: this._state.messages,
				aborted,
			});
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
			this.emit({
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
		};

		const controller = new AbortController();
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
