import type {
	AgentEvent,
	AgentRunConfig,
	AgentTransport,
	AssistantMessage,
	Message,
	ToolResultMessage,
} from "./types.js";
import { streamAnthropic } from "./providers/anthropic.js";
import { streamOpenAI } from "./providers/openai.js";

export interface ProviderTransportOptions {
	getApiKey?: (
		provider: string,
	) => Promise<string | undefined> | string | undefined;
	corsProxyUrl?: string;
}

export class ProviderTransport implements AgentTransport {
	constructor(private options: ProviderTransportOptions = {}) {}

	async *run(
		messages: Message[],
		userMessage: Message,
		cfg: AgentRunConfig,
		signal?: AbortSignal,
	): AsyncGenerator<AgentEvent, void, unknown> {
		const { model, systemPrompt, tools } = cfg;

		// Get API key
		let apiKey: string | undefined;
		if (this.options.getApiKey) {
			apiKey = await this.options.getApiKey(model.provider);
		}

		if (!apiKey) {
			throw new Error(
				`No API key found for provider "${model.provider}". Please configure getApiKey.`,
			);
		}

		// Emit message_start for user message
		yield {
			type: "message_start",
			message: userMessage,
		};

		// Build context
		const context = {
			systemPrompt,
			messages: [...messages, userMessage],
			tools,
		};

		// Stream from provider
		const streamOptions = {
			apiKey,
			maxTokens: model.maxTokens,
			signal,
		};

		let stream: AsyncGenerator<any, void, unknown>;

		if (model.api === "anthropic-messages") {
			stream = streamAnthropic(model as any, context, {
				...streamOptions,
				thinking: cfg.reasoning,
			});
		} else if (
			model.api === "openai-responses" ||
			model.api === "openai-completions"
		) {
			stream = streamOpenAI(model as any, context, streamOptions);
		} else {
			throw new Error(`Unsupported API: ${model.api}`);
		}

		let currentAssistantMessage: AssistantMessage | null = null;
		const toolCallsToExecute: Array<{
			id: string;
			name: string;
			arguments: any;
		}> = [];

		// Process events from provider
		for await (const event of stream) {
			if (event.type === "start") {
				currentAssistantMessage = event.partial;
				if (currentAssistantMessage) {
					yield {
						type: "message_start",
						message: currentAssistantMessage,
					};
				}
			} else if (
				event.type === "text_delta" ||
				event.type === "thinking_delta" ||
				event.type === "toolcall_delta"
			) {
				if (currentAssistantMessage) {
					yield {
						type: "message_update",
						message: currentAssistantMessage,
						assistantMessageEvent: event,
					};
				}
			} else if (event.type === "toolcall_end") {
				toolCallsToExecute.push({
					id: event.toolCall.id,
					name: event.toolCall.name,
					arguments: event.toolCall.arguments,
				});
			} else if (event.type === "done") {
				if (currentAssistantMessage) {
					yield {
						type: "message_end",
						message: currentAssistantMessage,
					};

					// Execute tools if present
					if (toolCallsToExecute.length > 0) {
						const toolResults: ToolResultMessage[] = [];

						for (const toolCall of toolCallsToExecute) {
							yield {
								type: "tool_execution_start",
								toolCallId: toolCall.id,
								toolName: toolCall.name,
								args: toolCall.arguments,
							};

							const tool = tools.find((t) => t.name === toolCall.name);
							if (!tool) {
								const errorResult: ToolResultMessage = {
									role: "toolResult",
									toolCallId: toolCall.id,
									toolName: toolCall.name,
									content: [
										{
											type: "text",
											text: `Error: Tool "${toolCall.name}" not found`,
										},
									],
									isError: true,
									timestamp: Date.now(),
								};
								toolResults.push(errorResult);

								yield {
									type: "tool_execution_end",
									toolCallId: toolCall.id,
									toolName: toolCall.name,
									result: errorResult,
									isError: true,
								};
								continue;
							}

							try {
								const result = await tool.execute(
									toolCall.id,
									toolCall.arguments,
									signal,
								);

								const toolResultMessage: ToolResultMessage = {
									role: "toolResult",
									toolCallId: toolCall.id,
									toolName: toolCall.name,
									content: result.content,
									details: result.details,
									isError: result.isError || false,
									timestamp: Date.now(),
								};
								toolResults.push(toolResultMessage);

								yield {
									type: "tool_execution_end",
									toolCallId: toolCall.id,
									toolName: toolCall.name,
									result: toolResultMessage,
									isError: toolResultMessage.isError,
								};
							} catch (error: unknown) {
								const errorMessage =
									error instanceof Error ? error.message : String(error);
								const errorResult: ToolResultMessage = {
									role: "toolResult",
									toolCallId: toolCall.id,
									toolName: toolCall.name,
									content: [
										{
											type: "text",
											text: `Error: ${errorMessage}`,
										},
									],
									isError: true,
									timestamp: Date.now(),
								};
								toolResults.push(errorResult);

								yield {
									type: "tool_execution_end",
									toolCallId: toolCall.id,
									toolName: toolCall.name,
									result: errorResult,
									isError: true,
								};
							}
						}

						// Continue conversation with tool results
						const allMessages = [
							...messages,
							userMessage,
							currentAssistantMessage,
							...toolResults,
						];

						// Recursive call for tool use continuation
						yield* this.run(
							allMessages,
							toolResults[0], // Use first tool result as trigger
							cfg,
							signal,
						);
					}
				}
			} else if (event.type === "error") {
				if (currentAssistantMessage) {
					yield {
						type: "message_end",
						message: currentAssistantMessage,
					};
				}
			}
		}
	}
}
