import { defaultActionFirewall } from "../safety/action-firewall.js";
import { trackUsage } from "../tracking/cost-tracker.js";
import type { ActionApprovalService } from "./action-approval.js";
import { streamAnthropic } from "./providers/anthropic.js";
import { streamOpenAI } from "./providers/openai.js";
import type {
	AgentEvent,
	AgentRunConfig,
	AgentTransport,
	AssistantMessage,
	Message,
	ToolResultMessage,
} from "./types.js";

/**
 * Configuration options for ProviderTransport.
 */
export interface ProviderTransportOptions {
	/** Function to retrieve API keys for providers (can be async) */
	getApiKey?: (
		provider: string,
	) => Promise<string | undefined> | string | undefined;
	/** Optional CORS proxy URL for browser-based usage */
	corsProxyUrl?: string;
	/** Optional approval service for destructive tool calls */
	approvalService?: ActionApprovalService;
}

/**
 * Calculate cost in USD based on token usage and model pricing.
 *
 * @param usage - Token counts for input, output, cache read, and cache write
 * @param costConfig - Pricing per million tokens for each category (in USD per million tokens)
 * @returns Total cost in USD
 */
function calculateCost(
	usage: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	},
	costConfig: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	},
): number {
	const inputCost = ((usage.input || 0) * costConfig.input) / 1_000_000;
	const outputCost = ((usage.output || 0) * costConfig.output) / 1_000_000;
	const cacheReadCost =
		((usage.cacheRead || 0) * costConfig.cacheRead) / 1_000_000;
	const cacheWriteCost =
		((usage.cacheWrite || 0) * costConfig.cacheWrite) / 1_000_000;

	return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

/**
 * Universal transport layer that abstracts LLM provider differences.
 *
 * This class handles:
 * - API key management
 * - Provider-specific streaming format conversion
 * - Token usage tracking and cost calculation
 * - Tool call format normalization
 * - Error handling and abort signals
 *
 * Supports multiple providers through a unified interface:
 * - Anthropic (Claude)
 * - OpenAI (GPT) and OpenAI-compatible APIs (Groq, xAI, etc.)
 *
 * @example
 * ```typescript
 * const transport = new ProviderTransport({
 *   getApiKey: async (provider) => process.env[`${provider.toUpperCase()}_API_KEY`]
 * });
 *
 * for await (const event of transport.run(messages, userMsg, config, signal)) {
 *   if (event.type === 'content_block_delta') {
 *     process.stdout.write(event.text);
 *   }
 * }
 * ```
 */
export class ProviderTransport implements AgentTransport {
	/**
	 * Creates a new ProviderTransport instance.
	 *
	 * @param options - Configuration options including API key retrieval
	 */
	constructor(private options: ProviderTransportOptions = {}) {}

	/**
	 * Streams an LLM completion from the configured provider.
	 *
	 * This generator yields events as they arrive from the provider, including:
	 * - message_start: User message acknowledgment
	 * - content_block_start: Start of text or thinking block
	 * - content_block_delta: Incremental text updates
	 * - tool_call: Tool invocation request
	 * - message_stop: Completion finished with usage stats
	 *
	 * @param messages - Full conversation history including the current user message
	 * @param userMessage - The current user message being responded to
	 * @param cfg - Run configuration (model, system prompt, tools, reasoning level)
	 * @param signal - Optional AbortSignal to cancel the request
	 * @yields AgentEvent objects representing the streaming response
	 * @throws Error if API key is missing or provider request fails
	 */
	async *run(
		messages: Message[],
		userMessage: Message,
		cfg: AgentRunConfig,
		signal?: AbortSignal,
	): AsyncGenerator<AgentEvent, void, unknown> {
		const { model, systemPrompt, tools } = cfg;
		const firewall = defaultActionFirewall;

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
							const cost = model.cost ? calculateCost(usage, model.cost) : 0;

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

							let approvalAllowed = true;
							let approvalReason: string | undefined;
							const verdict = firewall.evaluate({
								toolName: toolCall.name,
								args: toolCall.arguments,
							});
							if (verdict.action === "require_approval") {
								const approvalService = this.options.approvalService;
								if (approvalService) {
									const request = {
										id: toolCall.id,
										toolName: toolCall.name,
										args: toolCall.arguments,
										reason: verdict.reason,
									};
									const shouldEmitEvents =
										approvalService.requiresUserInteraction();
									if (shouldEmitEvents) {
										yield {
											type: "action_approval_required",
											request,
										};
									}

									const decision = await approvalService.requestApproval(
										request,
										signal,
									);
									if (shouldEmitEvents) {
										yield {
											type: "action_approval_resolved",
											request,
											decision,
										};
									}

									if (!decision.approved) {
										approvalAllowed = false;
										approvalReason = decision.reason ?? verdict.reason;
									}
								}
							}

							if (!approvalAllowed) {
								const deniedResult: ToolResultMessage = {
									role: "toolResult",
									toolCallId: toolCall.id,
									toolName: toolCall.name,
									content: [
										{
											type: "text",
											text: approvalReason ?? "Action denied",
										},
									],
									isError: true,
									timestamp: Date.now(),
								};
								toolResults.push(deniedResult);
								yield {
									type: "tool_execution_end",
									toolCallId: toolCall.id,
									toolName: toolCall.name,
									result: deniedResult,
									isError: true,
								};
								continue;
							}

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
