import { envApiKeyMap } from "../providers/api-keys.js";
import type { AuthCredential } from "../providers/auth.js";
import {
	HUMAN_EGRESS_PII_RULE_ID,
	defaultActionFirewall,
} from "../safety/action-firewall.js";
import {
	WorkflowStateError,
	WorkflowStateTracker,
	applyWorkflowStateHooks,
	isWorkflowTrackedTool,
} from "../safety/workflow-state.js";
import { ToolError } from "../tools/tool-dsl.js";
import { trackUsage } from "../tracking/cost-tracker.js";
import type {
	ActionApprovalService,
	WorkflowStateSnapshot,
} from "./action-approval.js";
import { getStoredCredentials } from "./keys.js";
import { streamAnthropic } from "./providers/anthropic.js";
import { streamGoogle } from "./providers/google.js";
import { streamOpenAI } from "./providers/openai.js";
import { validateToolArguments } from "./providers/validation.js";
import type {
	AgentEvent,
	AgentRunConfig,
	AgentTransport,
	AppMessage,
	AssistantMessage,
	Message,
	ToolCall,
	ToolResultMessage,
} from "./types.js";

interface ToolExecutionOutcome {
	message: ToolResultMessage;
	isError: boolean;
}

interface PendingExecution {
	toolCall: ToolCall;
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

function resolveEnvCredential(provider: string): AuthCredential | undefined {
	const vars = envApiKeyMap[provider as keyof typeof envApiKeyMap] ?? [];
	for (const name of vars) {
		const value = process.env[name];
		if (!value) continue;
		const isAnthropicOAuth =
			provider === "anthropic" && name === "ANTHROPIC_OAUTH_TOKEN";
		return {
			provider,
			token: value,
			type: isAnthropicOAuth ? "anthropic-oauth" : "api-key",
			source: isAnthropicOAuth ? "anthropic_oauth_env" : "env",
			envVar: name,
		};
	}
	return undefined;
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

function stableStringify(value: unknown): string {
	const seen = new WeakSet();
	const sorter = (input: any): any => {
		if (input === null || typeof input !== "object") return input;
		if (seen.has(input)) return "[Circular]";
		seen.add(input);
		let output: any;
		if (Array.isArray(input)) {
			output = input.map(sorter);
		} else {
			const sortedKeys = Object.keys(input).sort();
			output = {};
			for (const key of sortedKeys) {
				output[key] = sorter(input[key]);
			}
		}
		seen.delete(input);
		return output;
	};
	return JSON.stringify(sorter(value));
}

function formatPendingPii(snapshot: WorkflowStateSnapshot): string {
	if (snapshot.pendingPii.length === 0) {
		return "(none tracked)";
	}
	return snapshot.pendingPii
		.map(
			(artifact) =>
				`• ${artifact.label} (artifact: ${artifact.id}, source: ${artifact.sourceToolCallId})`,
		)
		.join("\n");
}

function buildPiiPolicyResult(
	toolCall: ToolCall,
	snapshot: WorkflowStateSnapshot,
): ToolResultMessage {
	const artifactSummary = formatPendingPii(snapshot);
	const orphanedSummary = snapshot.orphanedRedactions.length
		? `Orphaned redaction attempts: ${snapshot.orphanedRedactions.join(", ")}`
		: "";
	const guidanceText = `Policy block: unredacted PII is still pending, so "${toolCall.name}" cannot run.\n\nArtifacts requiring redaction:\n${artifactSummary}\n\n${orphanedSummary ? `${orphanedSummary}\n\n` : ""}Next steps: run \`redact_transcript\` (or your workflow's redaction tool) for each artifact above, then retry the egress action.`;
	return {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [{ type: "text", text: guidanceText }],
		isError: true,
		timestamp: Date.now(),
	};
}

export class ProviderTransport implements AgentTransport {
	private workflowState = new WorkflowStateTracker();
	private warnedAboutWorkflowConcurrency = false;
	private recentToolCalls: Array<{ name: string; signature: string }> = [];
	private static readonly DOOM_LOOP_THRESHOLD = 3;

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
		this.workflowState.reset();
		this.recentToolCalls = [];

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
		if (!credential) {
			const envCredential = resolveEnvCredential(model.provider);
			if (envCredential) {
				credential = envCredential;
			}
		}
		if (!credential) {
			const stored = getStoredCredentials(model.provider);
			if (stored.apiKey) {
				credential = {
					provider: model.provider,
					token: stored.apiKey,
					type: stored.authType ?? "api-key",
					source: "custom_literal",
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
			const toolCallsToExecute: ToolCall[] = [];
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
				model.api === "openai-completions" ||
				model.api === "openai-responses"
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
					continue;
				}

				if (
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
					continue;
				}

				if (event.type === "toolcall_end") {
					const rawArgs = event.toolCall.arguments;
					const normalizedArgs =
						rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
							? (rawArgs as Record<string, unknown>)
							: {};
					toolCallsToExecute.push({
						type: "toolCall",
						id: event.toolCall.id,
						name: event.toolCall.name,
						arguments: normalizedArgs,
					});
					continue;
				}

				if (event.type === "done") {
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
					continue;
				}

				if (event.type === "error") {
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
				const configuredConcurrency =
					this.options.maxConcurrentToolExecutions ?? 2;
				const hasWorkflowTrackedTool = toolCallsToExecute.some((call) =>
					isWorkflowTrackedTool(call.name),
				);
				const requiresSerializedTurn =
					hasWorkflowTrackedTool && toolCallsToExecute.length > 1;
				let concurrencyLimit = configuredConcurrency;
				if (configuredConcurrency > 1 && requiresSerializedTurn) {
					concurrencyLimit = 1;
					if (!this.warnedAboutWorkflowConcurrency) {
						console.warn(
							"[provider-transport] WorkflowStateTracker currently requires serialized tool execution; maxConcurrentToolExecutions has been capped at 1 until invariants support parallelism.",
						);
						this.warnedAboutWorkflowConcurrency = true;
					}
				}

				const buildExecutionEvents = (
					toolCall: ToolCall,
					message: ToolResultMessage,
					isError: boolean,
				): AgentEvent[] => [
					{ type: "message_start", message } as AgentEvent,
					{ type: "message_end", message } as AgentEvent,
					{
						type: "tool_execution_end",
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						result: message,
						isError,
					} as AgentEvent,
				];
				const emitToolResult = (
					message: ToolResultMessage,
					toolCall: ToolCall,
					isError: boolean,
				) => {
					try {
						applyWorkflowStateHooks({
							toolCall,
							result: message,
							tracker: this.workflowState,
							isError,
						});
						toolResults.push(message);
						return buildExecutionEvents(toolCall, message, isError);
					} catch (error) {
						if (error instanceof WorkflowStateError) {
							const workflowErrorResult: ToolResultMessage = {
								role: "toolResult",
								toolCallId: toolCall.id,
								toolName: toolCall.name,
								content: [{ type: "text", text: error.message }],
								isError: true,
								timestamp: Date.now(),
							};
							toolResults.push(workflowErrorResult);
							return buildExecutionEvents(toolCall, workflowErrorResult, true);
						}
						throw error;
					}
				};

				const scheduleResolveIfNeeded = async (): Promise<AgentEvent[]> => {
					if (pendingExecutions.length < concurrencyLimit) {
						return [];
					}
					const resolved = await waitForNextExecution(pendingExecutions);
					const outcome = resolved.outcome;
					return emitToolResult(
						outcome.message,
						resolved.execution.toolCall,
						outcome.isError,
					);
				};

				for (const toolCall of toolCallsToExecute) {
					const signature = stableStringify(toolCall.arguments);
					const tail = this.recentToolCalls
						.concat({ name: toolCall.name, signature })
						.slice(-ProviderTransport.DOOM_LOOP_THRESHOLD);
					const doomLoop =
						tail.length === ProviderTransport.DOOM_LOOP_THRESHOLD &&
						tail.every(
							(entry) =>
								entry.name === toolCall.name && entry.signature === signature,
						);
					if (doomLoop) {
						const doomMessage: ToolResultMessage = {
							role: "toolResult",
							toolCallId: toolCall.id,
							toolName: toolCall.name,
							content: [
								{
									type: "text",
									text: `Blocked "${toolCall.name}" to prevent a possible doom loop: same tool invoked ${ProviderTransport.DOOM_LOOP_THRESHOLD} times with identical arguments.`,
								},
							],
							isError: true,
							timestamp: Date.now(),
						};
						for (const evt of emitToolResult(doomMessage, toolCall, true)) {
							yield evt;
						}
						continue;
					}
					this.recentToolCalls.push({ name: toolCall.name, signature });
					if (
						this.recentToolCalls.length >
						ProviderTransport.DOOM_LOOP_THRESHOLD + 2
					) {
						this.recentToolCalls.shift();
					}

					yield {
						type: "tool_execution_start",
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						args: toolCall.arguments,
					};

					let approvalAllowed = true;
					let approvalReason: string | undefined;
					const workflowSnapshot = this.workflowState.snapshot();
					const verdict = firewall.evaluate({
						toolName: toolCall.name,
						args: toolCall.arguments,
						metadata: {
							workflowState: workflowSnapshot,
						},
					});
					if (
						verdict.action === "require_approval" &&
						verdict.ruleId === HUMAN_EGRESS_PII_RULE_ID
					) {
						const policyResult = buildPiiPolicyResult(
							toolCall,
							workflowSnapshot,
						);
						for (const event of emitToolResult(policyResult, toolCall, true)) {
							yield event;
						}
						continue;
					}
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
						for (const event of emitToolResult(deniedResult, toolCall, true)) {
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
						for (const event of emitToolResult(errorResult, toolCall, true)) {
							yield event;
						}
						continue;
					}

					let validatedArgs: Record<string, unknown>;
					try {
						validatedArgs = validateToolArguments(tool, toolCall);
					} catch (error: unknown) {
						const validationErrorResult: ToolResultMessage = {
							role: "toolResult",
							toolCallId: toolCall.id,
							toolName: toolCall.name,
							content: [
								{
									type: "text",
									text: error instanceof Error ? error.message : String(error),
								},
							],
							isError: true,
							timestamp: Date.now(),
						};
						for (const event of emitToolResult(
							validationErrorResult,
							toolCall,
							true,
						)) {
							yield event;
						}
						continue;
					}

					const executionPromise: Promise<ToolExecutionOutcome> =
						Promise.resolve()
							.then(() => tool.execute(toolCall.id, validatedArgs, signal))
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
											text:
												error instanceof Error
													? error.message
													: `Error: ${String(error)}`,
										},
									],
									details:
										error instanceof ToolError ? error.toolDetails : undefined,
									isError: true,
									timestamp: Date.now(),
								},
								isError: true,
							}));

					pendingExecutions.push({
						toolCall,
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
						resolved.execution.toolCall,
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
	execution: PendingExecution;
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
		execution: race.entry,
		outcome: race.outcome,
	};
}
