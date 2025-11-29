import type { AuthCredential } from "../providers/auth.js";
import { defaultActionFirewall } from "../safety/action-firewall.js";
import { trackUsage } from "../tracking/cost-tracker.js";
import type { ActionApprovalService } from "./action-approval.js";
import { streamAnthropic } from "./providers/anthropic.js";
import { streamGoogle } from "./providers/google.js";
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

interface ToolExecutionOutcome {
	message: ToolResultMessage;
	isError: boolean;
}

interface PendingExecution {
	toolCallId: string;
	toolName: string;
	promise: Promise<ToolExecutionOutcome>;
}

export interface ProviderTransportOptions {
	getApiKey?: (
		provider: string,
	) => Promise<string | undefined> | string | undefined;
	getAuthContext?: (
		provider: string,
	) => AuthCredential | undefined | Promise<AuthCredential | undefined>;
	corsProxyUrl?: string;
	approvalService?: ActionApprovalService;
	maxConcurrentToolExecutions?: number;
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

		let credential: AuthCredential | undefined;
		if (this.options.getAuthContext) {
			credential = await this.options.getAuthContext(model.provider);
		}
		if (!credential && this.options.getApiKey) {
			const fallbackKey = await this.options.getApiKey(model.provider);
			if (fallbackKey) {
				credential = {
					provider: model.provider,
					token: fallbackKey,
					type: "api-key",
					source: "env",
				};
			}
		}

		const apiKey = credential?.token;
		if (!apiKey) {
			throw new Error(
				`No credentials found for provider "${model.provider}". Provide an API key or configure getAuthContext.`,
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
			authType: credential?.type ?? "api-key",
		};

		let hasMoreToolCalls = true;
		const allMessages = [...context.messages];
		let queuedMessages = cfg.getQueuedMessages
			? await cfg.getQueuedMessages<AppMessage>()
			: [];
		let prefetchedQueuedMessages: typeof queuedMessages | null = null;

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
			} else if (model.api === "google-generative-ai") {
				stream = streamGoogle(model as any, currentContext, {
					...streamOptions,
					thinking: cfg.reasoning,
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
							if (credential?.type !== "anthropic-oauth") {
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
				const pendingExecutions: PendingExecution[] = [];
				const concurrencyLimit = Math.max(
					1,
					this.options.maxConcurrentToolExecutions ?? 2,
				);

				const emitToolResult = (
					message: ToolResultMessage,
					toolCallId: string,
					toolName: string,
					isError: boolean,
				) => {
					toolResults.push(message);
					return [
						{ type: "message_start", message } as AgentEvent,
						{ type: "message_end", message } as AgentEvent,
						{
							type: "tool_execution_end",
							toolCallId,
							toolName,
							result: message,
							isError,
						} as AgentEvent,
					];
				};

				const scheduleResolveIfNeeded = async (): Promise<AgentEvent[]> => {
					if (pendingExecutions.length < concurrencyLimit) {
						return [];
					}
					const resolved = await waitForNextExecution(pendingExecutions);
					const outcome = resolved.outcome;
					return emitToolResult(
						outcome.message,
						resolved.toolCallId,
						resolved.toolName,
						outcome.isError,
					);
				};

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
						for (const event of emitToolResult(
							deniedResult,
							toolCall.id,
							toolCall.name,
							true,
						)) {
							yield event;
						}
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
						for (const event of emitToolResult(
							errorResult,
							toolCall.id,
							toolCall.name,
							true,
						)) {
							yield event;
						}
						continue;
					}

					const executionPromise: Promise<ToolExecutionOutcome> =
						Promise.resolve()
							.then(() => tool.execute(toolCall.id, toolCall.arguments, signal))
							.then((result) => ({
								message: {
									role: "toolResult" as const,
									toolCallId: toolCall.id,
									toolName: toolCall.name,
									content: result.content,
									details: result.details,
									isError: result.isError || false,
									timestamp: Date.now(),
								},
								isError: result.isError || false,
							}))
							.catch((error: unknown) => ({
								message: {
									role: "toolResult" as const,
									toolCallId: toolCall.id,
									toolName: toolCall.name,
									content: [
										{
											type: "text",
											text: `Error: ${error instanceof Error ? error.message : String(error)}`,
										},
									],
									isError: true,
									timestamp: Date.now(),
								},
								isError: true,
							}));

					pendingExecutions.push({
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						promise: executionPromise,
					});
					const events = await scheduleResolveIfNeeded();
					for (const event of events) {
						yield event;
					}
				}

				while (pendingExecutions.length > 0) {
					const resolved = await waitForNextExecution(pendingExecutions);
					const outcome = resolved.outcome;
					for (const event of emitToolResult(
						outcome.message,
						resolved.toolCallId,
						resolved.toolName,
						outcome.isError,
					)) {
						yield event;
					}
				}

				if (cfg.getQueuedMessages) {
					prefetchedQueuedMessages = await cfg.getQueuedMessages<AppMessage>();
					if (prefetchedQueuedMessages.length > 0) {
						pendingNextTurn = true;
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

			if (prefetchedQueuedMessages) {
				queuedMessages = prefetchedQueuedMessages;
				prefetchedQueuedMessages = null;
			} else {
				queuedMessages = cfg.getQueuedMessages
					? await cfg.getQueuedMessages<AppMessage>()
					: [];
			}

			hasMoreToolCalls = encounteredError ? false : pendingNextTurn;
		}
	}
}

async function waitForNextExecution(
	pendingExecutions: PendingExecution[],
): Promise<{
	toolCallId: string;
	toolName: string;
	outcome: ToolExecutionOutcome;
}> {
	const race = await Promise.race(
		pendingExecutions.map((entry) =>
			entry.promise.then((outcome) => ({ entry, outcome })),
		),
	);
	const index = pendingExecutions.indexOf(race.entry);
	if (index >= 0) {
		pendingExecutions.splice(index, 1);
	}
	return {
		toolCallId: race.entry.toolCallId,
		toolName: race.entry.toolName,
		outcome: race.outcome,
	};
}
