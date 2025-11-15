import { streamAnthropic } from "./providers/anthropic.js";
import { streamOpenAI } from "./providers/openai.js";
import { trackUsage } from "../tracking/cost-tracker.js";
import type {
	AgentEvent,
	AgentRunConfig,
	AgentTransport,
	AssistantMessage,
	Message,
	ToolResultMessage,
} from "./types.js";

export interface ProviderTransportOptions {
	getApiKey?: (
		provider: string,
	) => Promise<string | undefined> | string | undefined;
	corsProxyUrl?: string;
}

/**
 * Calculate cost in USD based on token usage
 */
function calculateCost(
	usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
	costConfig: { input: number; output: number; cacheRead: number; cacheWrite: number }
): number {
	const inputCost = (usage.input || 0) * costConfig.input;
	const outputCost = (usage.output || 0) * costConfig.output;
	const cacheReadCost = (usage.cacheRead || 0) * costConfig.cacheRead;
	const cacheWriteCost = (usage.cacheWrite || 0) * costConfig.cacheWrite;
	
	return inputCost + outputCost + cacheReadCost + cacheWriteCost;
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
		// Note: messages already includes userMessage from the caller
		const context = {
			systemPrompt,
			messages: messages,
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

		// WHILE LOOP for tool use continuation (like Mario's agentLoop)
		let hasMoreToolCalls = true;
		const allMessages = [...context.messages];

		while (hasMoreToolCalls) {
			let currentAssistantMessage: AssistantMessage | null = null;
			const toolCallsToExecute: Array<{
				id: string;
				name: string;
				arguments: any;
			}> = [];

			// Update context with current messages
			const currentContext = {
				...context,
				messages: allMessages,
			};

			// Create new stream for this iteration
			if (model.api === "anthropic-messages") {
				stream = streamAnthropic(model as any, currentContext, {
					...streamOptions,
					thinking: cfg.reasoning,
				});
			} else if (
				model.api === "openai-responses" ||
				model.api === "openai-completions"
			) {
				stream = streamOpenAI(model as any, currentContext, streamOptions);
			}

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
						
						// Track usage and cost
						if (currentAssistantMessage.usage) {
							const usage = currentAssistantMessage.usage;
							const cost = model.cost 
								? calculateCost(usage, model.cost)
								: 0;
							
							try {
								trackUsage({
									provider: model.provider,
									model: model.id,
									tokensInput: usage.input || 0,
									tokensOutput: usage.output || 0,
									tokensCacheRead: usage.cacheRead,
									tokensCacheWrite: usage.cacheWrite,
									cost,
								});
							} catch (error) {
								// Don't fail the request if tracking fails
								console.warn("[Cost Tracking] Failed to track usage:", error);
							}
						}
					}

					hasMoreToolCalls = toolCallsToExecute.length > 0;

					if (hasMoreToolCalls) {
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

						if (currentAssistantMessage) {
							allMessages.push(currentAssistantMessage);
						}
						allMessages.push(...toolResults);
					}
				} else if (event.type === "error") {
					if (currentAssistantMessage) {
						yield {
							type: "message_end",
							message: currentAssistantMessage,
						};
					}
					hasMoreToolCalls = false;
				}
			}
		}
	}
}
