import { defaultActionFirewall } from "../safety/action-firewall.js";
import { trackUsage } from "../tracking/cost-tracker.js";
import type { ActionApprovalService } from "./action-approval.js";
import { streamAnthropic } from "./providers/anthropic.js";
import { streamOpenAI } from "./providers/openai.js";
import type {
	AgentEvent,
	AgentRunConfig,
	AgentTransport,
	AppMessage,
	AssistantMessage,
	Message,
	ToolResultMessage,
} from "./types.js";

export interface ProviderTransportOptions {
	getApiKey?: (
		provider: string,
	) => Promise<string | undefined> | string | undefined;
	corsProxyUrl?: string;
	approvalService?: ActionApprovalService;
}

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

export class ProviderTransport implements AgentTransport {
	constructor(private options: ProviderTransportOptions = {}) {}

	async *run(
		messages: Message[],
		userMessage: Message,
		cfg: AgentRunConfig,
		signal?: AbortSignal,
	): AsyncGenerator<AgentEvent, void, unknown> {
		const { systemPrompt, tools } = cfg;
		let model = cfg.model;
		const firewall = defaultActionFirewall;

		let apiKey: string | undefined;
		if (this.options.getApiKey) {
			apiKey = await this.options.getApiKey(model.provider);
		}

		if (!apiKey) {
			throw new Error(
				`No API key found for provider "${model.provider}". Please configure getApiKey.`,
			);
		}

		yield { type: "message_start", message: userMessage };

		const context = {
			systemPrompt,
			messages,
			tools,
		};

		if (this.options.corsProxyUrl && model.baseUrl) {
			model = {
				...model,
				baseUrl: `${this.options.corsProxyUrl}/?url=${encodeURIComponent(model.baseUrl)}`,
			};
		}

		const streamOptions = {
			apiKey,
			maxTokens: model.maxTokens,
			signal,
		};

		let hasMoreToolCalls = true;
		const allMessages = [...context.messages];
		let queuedMessages = cfg.getQueuedMessages
			? await cfg.getQueuedMessages<AppMessage>()
			: [];

		while (hasMoreToolCalls || queuedMessages.length > 0) {
			yield { type: "turn_start" };

			if (queuedMessages.length > 0) {
				for (const queued of queuedMessages) {
					yield { type: "message_start", message: queued.original };
					yield { type: "message_end", message: queued.original };
					if (queued.llm) {
						allMessages.push(queued.llm);
					}
				}
				queuedMessages = [];
			}

			let currentAssistantMessage: AssistantMessage | null = null;
			let completedAssistantMessage: AssistantMessage | null = null;
			const toolCallsToExecute: Array<{
				id: string;
				name: string;
				arguments: any;
			}> = [];
			let toolResults: ToolResultMessage[] = [];
			let pendingNextTurn = false;
			let encounteredError = false;

			const currentContext = {
				...context,
				messages: allMessages,
			};

			let stream: AsyncGenerator<any, void, unknown>;
			if (model.api === "anthropic-messages") {
				stream = streamAnthropic(model as any, currentContext, {
					...streamOptions,
					thinking: cfg.reasoning,
				});
			} else if (
				model.api === "openai-responses" ||
				model.api === "openai-completions"
			) {
				stream = streamOpenAI(model as any, currentContext, {
					...streamOptions,
					reasoningEffort: cfg.reasoning,
				});
			} else {
				throw new Error(`Unsupported API: ${model.api}`);
			}

			for await (const event of stream) {
				if (event.type === "start") {
					currentAssistantMessage = event.partial;
					if (currentAssistantMessage) {
						yield { type: "message_start", message: currentAssistantMessage };
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
						completedAssistantMessage = currentAssistantMessage;
						yield { type: "message_end", message: currentAssistantMessage };
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
								console.warn("[Cost Tracking] Failed to track usage:", error);
							}
						}
					}
					pendingNextTurn = toolCallsToExecute.length > 0;
				} else if (event.type === "error") {
					completedAssistantMessage = event.error;
					if (currentAssistantMessage) {
						yield { type: "message_end", message: currentAssistantMessage };
					}
					pendingNextTurn = false;
					encounteredError = true;
					break;
				}
			}

			if (toolCallsToExecute.length > 0) {
				toolResults = [];
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
								yield { type: "action_approval_required", request };
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
								{ type: "text", text: approvalReason ?? "Action denied" },
							],
							isError: true,
							timestamp: Date.now(),
						};
						toolResults.push(deniedResult);
						yield { type: "message_start", message: deniedResult };
						yield { type: "message_end", message: deniedResult };
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
						yield { type: "message_start", message: errorResult };
						yield { type: "message_end", message: errorResult };
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
						yield { type: "message_start", message: toolResultMessage };
						yield { type: "message_end", message: toolResultMessage };
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
							content: [{ type: "text", text: `Error: ${errorMessage}` }],
							isError: true,
							timestamp: Date.now(),
						};
						toolResults.push(errorResult);
						yield { type: "message_start", message: errorResult };
						yield { type: "message_end", message: errorResult };
						yield {
							type: "tool_execution_end",
							toolCallId: toolCall.id,
							toolName: toolCall.name,
							result: errorResult,
							isError: true,
						};
					}
				}
			}

			if (completedAssistantMessage) {
				allMessages.push(completedAssistantMessage);
			}
			allMessages.push(...toolResults);

			yield {
				type: "turn_end",
				message: completedAssistantMessage ??
					currentAssistantMessage ?? {
						role: "assistant",
						content: [],
						api: model.api,
						provider: model.provider,
						model: model.id,
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
						stopReason: "error",
						timestamp: Date.now(),
					},
				toolResults,
			};

			queuedMessages = cfg.getQueuedMessages
				? await cfg.getQueuedMessages<AppMessage>()
				: [];

			hasMoreToolCalls = encounteredError ? false : pendingNextTurn;
		}
	}
}
