import { randomUUID } from "node:crypto";
import type {
	AgentEvent,
	AgentRunConfig,
	AgentTransport,
	AssistantMessage,
	Message,
	ToolResultMessage,
} from "../agent/types.js";

export interface MockToolOperation {
	name: string;
	args: Record<string, any>;
	id?: string;
	onResult?: (result: ToolResultMessage) => void;
}

export class MockToolTransport implements AgentTransport {
	constructor(
		private readonly operations: MockToolOperation[],
		private readonly buildFinalText: () => string,
	) {}

	async *run(
		_messages: Message[],
		userMessage: AssistantMessage,
		config: AgentRunConfig,
		signal?: AbortSignal,
	): AsyncGenerator<AgentEvent, void, unknown> {
		yield { type: "message_start", message: userMessage };

		for (const operation of this.operations) {
			const toolCallId = operation.id ?? randomUUID();
			yield { type: "message_start", message: this.createToolCall(toolCallId, operation) };
			yield { type: "message_end", message: this.createToolCall(toolCallId, operation) };

			const tool = config.tools.find((def) => def.name === operation.name);
			if (!tool) {
				throw new Error(`Tool ${operation.name} is not registered.`);
			}

			yield {
				type: "tool_execution_start",
				toolCallId,
				toolName: operation.name,
				args: operation.args,
			};

			const toolResult = await tool.execute(toolCallId, operation.args, signal);
			const resultMessage: ToolResultMessage = {
				role: "toolResult",
				toolCallId,
				toolName: operation.name,
				content: toolResult.content,
				details: toolResult.details,
				isError: toolResult.isError ?? false,
				timestamp: Date.now(),
			};
			operation.onResult?.(resultMessage);

			yield {
				type: "tool_execution_end",
				toolCallId,
				toolName: operation.name,
				result: resultMessage,
				isError: resultMessage.isError,
			};
		}

		const finalMessage = this.createAssistantMessage(this.buildFinalText());
		yield { type: "message_start", message: finalMessage };
		yield { type: "message_end", message: finalMessage };
	}

	private createToolCall(toolCallId: string, operation: MockToolOperation): AssistantMessage {
		return {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: toolCallId,
					name: operation.name,
					arguments: operation.args,
				},
			],
			api: "openai-completions",
			provider: "mock",
			model: "mock-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
	}

	private createAssistantMessage(text: string): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "openai-completions",
			provider: "mock",
			model: "mock-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}
}
