import type {
	AgentEvent,
	AgentRunConfig,
	AgentTransport,
	AssistantMessage,
	Message,
} from "../../src/agent/types.js";

export class MockTransport implements AgentTransport {
	public lastSystemPrompt = "";
	private responses = new Map<string, string>();

	addResponse(role: string, content: string): void {
		this.responses.set(role, content);
	}

	async *run(
		messages: Message[],
		_userMessage: Message,
		config: AgentRunConfig,
	): AsyncGenerator<AgentEvent, void, unknown> {
		this.lastSystemPrompt = config.systemPrompt;

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "text",
					text: this.responses.get("assistant") || "Default response",
				},
			],
			api: "openai-completions",
			provider: "mock",
			model: "mock",
			usage: {
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
			stopReason: "stop",
			timestamp: Date.now(),
		};

		yield { type: "message_start", message: assistantMessage };
		yield { type: "message_end", message: assistantMessage };
	}

	async *continue(
		messages: Message[],
		config: AgentRunConfig,
	): AsyncGenerator<AgentEvent, void, unknown> {
		// Just delegate to run with an empty user message for mock purposes
		const dummyUserMessage: Message = {
			role: "user",
			content: [{ type: "text", text: "" }],
			timestamp: Date.now(),
		};
		yield* this.run(messages, dummyUserMessage, config);
	}
}
