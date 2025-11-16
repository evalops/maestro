import type {
	AgentEvent,
	AgentState,
	AgentTool,
	AgentTransport,
	AppMessage,
	AssistantMessage,
	Attachment,
	ImageContent,
	Message,
	Model,
	TextContent,
	ThinkingLevel,
	ToolResultMessage,
	UserMessage,
} from "./types.js";

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
	private messageTransformer?: (
		messages: AppMessage[],
	) => Message[] | Promise<Message[]>;
	private messageQueue: AppMessage[] = [];

	/**
	 * Creates a new Agent instance.
	 *
	 * @param opts - Configuration options including transport and initial state
	 */
	constructor(opts: AgentOptions) {
		this.transport = opts.transport;
		this.messageTransformer = opts.messageTransformer;

		this._state = {
			systemPrompt: "",
			model: null as any,
			thinkingLevel: "off",
			tools: [],
			messages: [],
			isStreaming: false,
			streamMessage: null,
			pendingToolCalls: new Map(),
			...opts.initialState,
		};
	}

	/**
	 * Gets the current agent state (read-only).
	 *
	 * @returns The current state including messages, model, tools, and streaming status
	 */
	get state(): AgentState {
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
	setModel(m: Model<any>): void {
		this._state.model = m;
	}

	/**
	 * Sets the thinking/reasoning level for extended reasoning models.
	 *
	 * @param l - Thinking level: "off", "low", "medium", "high", "max"
	 */
	setThinkingLevel(l: ThinkingLevel): void {
		this._state.thinkingLevel = l;
	}

	/**
	 * Sets the available tools that the model can invoke.
	 *
	 * @param t - Array of tool definitions with schemas and execute functions
	 */
	setTools(t: AgentTool<any>[]): void {
		this._state.tools = t;
	}

	/**
	 * Replaces the entire message history with a new set of messages.
	 *
	 * @param ms - New message array
	 */
	replaceMessages(ms: AppMessage[]): void {
		this._state.messages = ms;
	}

	/**
	 * Appends a single message to the conversation history.
	 *
	 * @param m - Message to append
	 */
	appendMessage(m: AppMessage): void {
		this._state.messages.push(m);
	}

	/**
	 * Queues a message for later processing.
	 *
	 * @param m - Message to queue
	 */
	async queueMessage(m: AppMessage): Promise<void> {
		this.messageQueue.push(m);
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
		// Build user message content as array (matching Mario's implementation)
		const content: Array<TextContent | ImageContent> = [
			{ type: "text", text: input },
		];

		if (attachments && attachments.length > 0) {
			for (const a of attachments) {
				if (a.type === "image") {
					content.push({
						type: "image",
						data: a.content,
						mimeType: a.mimeType,
					});
				} else if (a.type === "document" && a.extractedText) {
					content.push({
						type: "text",
						text: `\n\n[Document: ${a.fileName}]\n${a.extractedText}`,
					});
				}
			}
		}

		const userMessage: UserMessage = {
			role: "user",
			content,
			timestamp: Date.now(),
		};

		this._state.messages.push(userMessage);
		this._state.isStreaming = true;

		this.abortController = new AbortController();

		this.emit({ type: "agent_start" });
		this.emit({ type: "turn_start" });

		let aborted = false;

		try {
			// Transform messages if needed
			let messagesToSend: Message[] = this._state.messages;
			if (this.messageTransformer) {
				messagesToSend = await this.messageTransformer(this._state.messages);
			}

			// Get queued messages if any
			const queuedMessages = this.messageQueue.splice(0);
			messagesToSend = [...messagesToSend, ...queuedMessages];

			// Determine reasoning level
			let reasoning: "low" | "medium" | "high" | undefined;
			if (this._state.thinkingLevel !== "off" && this._state.model.reasoning) {
				reasoning =
					this._state.thinkingLevel === "minimal"
						? "low"
						: (this._state.thinkingLevel as any);
			}

			const runConfig = {
				systemPrompt: this._state.systemPrompt,
				tools: this._state.tools,
				model: this._state.model,
				reasoning,
			};

			const toolResults: AppMessage[] = [];
			let finalMessage: AppMessage | null = null;

			for await (const event of this.transport.run(
				messagesToSend, // Include userMessage in messages array
				userMessage,
				runConfig,
				this.abortController.signal,
			)) {
				if (event.type === "message_start") {
					this._state.streamMessage = event.message;
					this.emit(event);
				} else if (event.type === "message_update") {
					this._state.streamMessage = event.message;
					this.emit(event);
				} else if (event.type === "message_end") {
					this._state.streamMessage = null;
					this._state.messages.push(event.message);
					finalMessage = event.message;
					this.emit(event);
				} else if (event.type === "tool_execution_start") {
					this._state.pendingToolCalls.set(event.toolCallId, {
						toolName: event.toolName,
					});
					this.emit(event);
				} else if (event.type === "tool_execution_end") {
					this._state.pendingToolCalls.delete(event.toolCallId);
					if (event.result) {
						this._state.messages.push(event.result as any);
						toolResults.push(event.result as any);
					}
					this.emit(event);
				} else {
					this.emit(event);
				}
			}

			if (finalMessage) {
				this.emit({
					type: "turn_end",
					message: finalMessage,
					toolResults,
				});
			}

			this.emit({
				type: "agent_end",
				messages: this._state.messages,
			});
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
			this.abortController = undefined;
			if (this._state.pendingToolCalls.size > 0) {
				const reason = aborted
					? "Error: Operation aborted"
					: "Error: Tool execution did not complete";
				this.resolvePendingToolCalls(reason);
			}
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
			this._state.messages.push(abortedResult);
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
		modelOverride?: Model<any>,
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
