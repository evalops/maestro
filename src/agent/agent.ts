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
	UserMessage,
} from "./types.js";

export interface AgentOptions {
	initialState?: Partial<AgentState>;
	transport: AgentTransport;
	messageTransformer?: (
		messages: AppMessage[],
	) => Message[] | Promise<Message[]>;
}

export class Agent {
	private _state: AgentState;
	private listeners: Array<(e: AgentEvent) => void> = [];
	private abortController?: AbortController;
	private transport: AgentTransport;
	private messageTransformer?: (
		messages: AppMessage[],
	) => Message[] | Promise<Message[]>;
	private messageQueue: AppMessage[] = [];

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
			pendingToolCalls: new Set(),
			...opts.initialState,
		};
	}

	get state(): AgentState {
		return this._state;
	}

	subscribe(fn: (e: AgentEvent) => void): () => void {
		this.listeners.push(fn);
		return () => {
			const idx = this.listeners.indexOf(fn);
			if (idx >= 0) this.listeners.splice(idx, 1);
		};
	}

	private emit(event: AgentEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (error) {
				console.error("Error in agent event listener:", error);
			}
		}
	}

	setSystemPrompt(v: string): void {
		this._state.systemPrompt = v;
	}

	setModel(m: Model<any>): void {
		this._state.model = m;
	}

	setThinkingLevel(l: ThinkingLevel): void {
		this._state.thinkingLevel = l;
	}

	setTools(t: AgentTool<any>[]): void {
		this._state.tools = t;
	}

	replaceMessages(ms: AppMessage[]): void {
		this._state.messages = ms;
	}

	appendMessage(m: AppMessage): void {
		this._state.messages.push(m);
	}

	async queueMessage(m: AppMessage): Promise<void> {
		this.messageQueue.push(m);
	}

	clearMessages(): void {
		this._state.messages = [];
	}

	abort(): void {
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = undefined;
		}
	}

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
					this._state.pendingToolCalls.add(event.toolCallId);
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
				// Aborted, don't throw
			} else {
				this._state.error =
					error instanceof Error ? error.message : String(error);
				throw error;
			}
		} finally {
			this._state.isStreaming = false;
			this.abortController = undefined;
		}
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
