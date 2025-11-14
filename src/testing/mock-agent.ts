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
	args: Record<string, any> | (() => Record<string, any>);
	id?: string;
	onResult?: (result: ToolResultMessage) => void;
	error?: string;
}

export class MockToolTransport implements AgentTransport {
	constructor(
		private readonly operations: MockToolOperation[],
		private readonly buildFinalText: () => string,
	) {}

	async *run(
		_messages: Message[],
		userMessage: Message,
		config: AgentRunConfig,
		signal?: AbortSignal,
	): AsyncGenerator<AgentEvent, void, unknown> {
		yield { type: "message_start", message: userMessage };

		const throwIfAborted = () => {
			if (signal?.aborted) {
				const abortError = new Error("Operation aborted");
				abortError.name = "AbortError";
				throw abortError;
			}
		};

		for (const operation of this.operations) {
			throwIfAborted();
			const resolvedArgs =
				typeof operation.args === "function"
					? (operation.args as () => Record<string, any>)()
					: operation.args;
			const toolCallId = operation.id ?? randomUUID();
			const toolCallMessage = this.createToolCall(
				toolCallId,
				operation,
				resolvedArgs,
			);
			yield { type: "message_start", message: toolCallMessage };
			yield { type: "message_end", message: toolCallMessage };

			const tool = config.tools.find((def) => def.name === operation.name);
			if (!tool) {
				throw new Error(`Tool ${operation.name} is not registered.`);
			}

			yield {
				type: "tool_execution_start",
				toolCallId,
				toolName: operation.name,
				args: resolvedArgs,
			};

			try {
				if (operation.error) {
					throw new Error(operation.error);
				}
				const toolResult = await tool.execute(toolCallId, resolvedArgs, signal);
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
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") {
					const abortResult = this.createToolErrorResult(
						toolCallId,
						operation,
						"Operation aborted",
					);
					operation.onResult?.(abortResult);
					yield {
						type: "tool_execution_end",
						toolCallId,
						toolName: operation.name,
						result: abortResult,
						isError: true,
					};
					throw error;
				}

				const message = error instanceof Error ? error.message : String(error);
				const errorResult = this.createToolErrorResult(
					toolCallId,
					operation,
					message,
				);
				operation.onResult?.(errorResult);
				yield {
					type: "tool_execution_end",
					toolCallId,
					toolName: operation.name,
					result: errorResult,
					isError: true,
				};
			}

			throwIfAborted();
		}

		const finalMessage = this.createAssistantMessage(this.buildFinalText());
		yield { type: "message_start", message: finalMessage };
		yield { type: "message_end", message: finalMessage };
	}

	private createToolErrorResult(
		toolCallId: string,
		operation: MockToolOperation,
		message: string,
	): ToolResultMessage {
		return {
			role: "toolResult",
			toolCallId,
			toolName: operation.name,
			content: [
				{
					type: "text",
					text: `Error: ${message}`,
				},
			],
			isError: true,
			timestamp: Date.now(),
		};
	}

	private createToolCall(
		toolCallId: string,
		operation: MockToolOperation,
		args: Record<string, any>,
	): AssistantMessage {
		return {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: toolCallId,
					name: operation.name,
					arguments: args,
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
