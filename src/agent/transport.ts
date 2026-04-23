/**
 * Agent Transport Layer - LLM Communication and Tool Execution Orchestration
 *
 * This module is the heart of the agent's execution loop. It handles:
 * 1. Streaming communication with LLM providers (Anthropic, OpenAI, Google)
 * 2. Concurrent tool execution with configurable parallelism
 * 3. Safety enforcement via action firewall integration
 * 4. Hook system integration for tool lifecycle events
 *
 * ## Architecture Overview
 *
 * ```
 * User Message → Transport.run() → Provider Stream → Parse Tool Calls
 *                      ↓                                    ↓
 *              Emit Turn Events ←── Tool Results ←── Execute Tools
 *                      ↓                                    ↑
 *              Continue Loop ───────────────────────────────┘
 * ```
 *
 * ## Concurrent Tool Execution
 *
 * When the LLM returns multiple tool calls in a single response, we execute
 * them concurrently up to `maxConcurrentToolExecutions` limit. This improves
 * latency for independent operations (e.g., reading multiple files).
 *
 * However, tools that affect WorkflowStateTracker (PII tracking) are serialized
 * to maintain consistent state ordering. A warning is logged when this happens.
 *
 * ## Safety Integration Points
 *
 * 1. **Pre-execution**: Action firewall evaluates each tool call
 * 2. **Approval flow**: Dangerous actions trigger user approval
 * 3. **PII tracking**: WorkflowState hooks track data flow for egress prevention
 * 4. **Doom loop detection**: Identical consecutive tool calls are blocked
 * 5. **Rate limiting**: Per-tool rate limits prevent runaway execution
 *
 * ## Event Stream
 *
 * The transport yields AgentEvents that drive the UI:
 * - turn_start/end: Turn boundaries for UI state management
 * - message_start/update/end: Streaming content updates
 * - tool_execution_start/end: Tool lifecycle for progress display
 * - action_approval_required/resolved: Approval UI triggers
 *
 * @module agent/transport
 */

import { isContextFirewallBlockingEnabled } from "../config/env-vars.js";
import { type ToolHookService, createToolHookService } from "../hooks/index.js";
import { getProviderNetworkConfig } from "../providers/network-config.js";
import { isStreamIdleTimeoutError } from "../providers/stream-idle-timeout.js";
import { type Clock, systemClock } from "../utils/clock.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("transport");
import type { AuthCredential } from "../providers/auth.js";
import { defaultActionFirewall } from "../safety/action-firewall.js";
import { AdaptiveThresholds } from "../safety/adaptive-thresholds.js";
import { checkSessionLimits } from "../safety/policy.js";
import {
	type SafetyMiddleware,
	createSafetyMiddleware,
} from "../safety/safety-middleware.js";
import { SemanticJudge } from "../safety/semantic-judge.js";
import {
	WorkflowStateError,
	WorkflowStateTracker,
	applyWorkflowStateHooks,
	isWorkflowTrackedTool,
} from "../safety/workflow-state.js";
import { getOptimalConcurrency } from "../tools/parallel-execution.js";
import { trackUsage } from "../tracking/cost-tracker.js";
import { getTrainingHeaders } from "../training.js";
import type { ActionApprovalService } from "./action-approval.js";
import { getStoredCredentials } from "./keys.js";
import type { ToolRetryConfig, ToolRetryService } from "./tool-retry.js";
import { createProviderStream } from "./transport/create-provider-stream.js";
import {
	type PlatformToolExecutionBridge,
	getDefaultPlatformToolExecutionBridge,
} from "./transport/tool-execution-bridge.js";
import { createToolExecutionPromise } from "./transport/tool-execution.js";
import {
	type ToolSafetyVerdict,
	evaluateToolSafety,
} from "./transport/tool-safety-pipeline.js";
import {
	type PendingExecution,
	createToolUpdateQueue,
	waitForNextExecutionOrUpdate,
} from "./transport/tool-update-queue.js";
import {
	type SessionTokenCounter,
	type ToolAuditLogger,
	calculateCost,
	resolveEnvCredential,
} from "./transport/transport-utils.js";
import type {
	AgentEvent,
	AgentRunConfig,
	AgentToolResult,
	AgentTransport,
	AppMessage,
	AssistantMessage,
	Message,
	QueuedMessage,
	ToolCall,
	ToolResultMessage,
} from "./types.js";

// Re-export types for backward compatibility
export type {
	SessionTokenCounter,
	ToolAuditLogger,
} from "./transport/transport-utils.js";

export interface ClientToolExecutionService {
	requestExecution: (
		id: string,
		toolName: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	) => Promise<{ content: AgentToolResult["content"]; isError: boolean }>;
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
	toolRetryService?: ToolRetryService;
	toolRetryConfig?: ToolRetryConfig;
	clientToolService?: ClientToolExecutionService;
	maxConcurrentToolExecutions?: number;
	/** Hook service for tool lifecycle hooks (PreToolUse, PostToolUse, etc.) */
	hookService?: ToolHookService;
	/** Current working directory for hook execution (required if hookService not provided) */
	cwd?: string;
	/** Clock for timestamps and rate limiting (default: system clock) */
	clock?: Clock;
	/** Session token counter used for enforcing policy session limits */
	sessionTokenCounter?: SessionTokenCounter;
	/** Audit logger for sensitive tool execution events */
	auditLogger?: ToolAuditLogger;
	/** Optional Platform ToolExecution bridge override */
	platformToolExecutionBridge?: PlatformToolExecutionBridge | false;
}

/**
 * Provider Transport - Multi-provider LLM communication with safety controls
 *
 * The main transport implementation that handles streaming LLM responses,
 * executing tool calls, and enforcing safety policies. Supports Anthropic,
 * OpenAI, and Google providers through a unified interface.
 *
 * ## State Management
 *
 * - **workflowState**: Tracks PII artifacts for egress prevention
 * - **recentToolTimestamps**: Per-tool timestamps for rate limiting
 * - **safetyMiddleware**: Unified security (loop detection, sequence analysis, firewall)
 *
 * ## Safety Mechanisms
 *
 * ### SafetyMiddleware Integration
 * All safety checks are now handled through SafetyMiddleware:
 * - **Loop Detection**: Catches identical consecutive calls (replaces doom loop)
 * - **Sequence Analysis**: Detects suspicious behavioral patterns
 * - **Context Firewall**: Sanitizes arguments and blocks sensitive content
 *
 * ### Rate Limiting
 * Each tool has a per-window rate limit (TOOL_RATE_LIMIT calls per
 * TOOL_RATE_WINDOW_MS). This prevents runaway tool execution that could
 * waste resources or hit external API limits.
 *
 * ### Workflow State Serialization
 * When tools that track PII are present in a batch, concurrent execution
 * is disabled to ensure correct state ordering.
 */
export class ProviderTransport implements AgentTransport {
	/** Tracks PII artifacts through the workflow for egress prevention */
	private workflowState = new WorkflowStateTracker();
	/** Prevents repeated warnings about serialized workflow execution */
	private warnedAboutWorkflowConcurrency = false;
	/** Per-tool timestamp arrays for rate limiting enforcement */
	private recentToolTimestamps = new Map<string, number[]>();
	/** Safety middleware for sequence analysis and context sanitization */
	private readonly safetyMiddleware!: SafetyMiddleware;
	/** Adaptive thresholds for anomaly-based rate limiting */
	private readonly adaptiveThresholds!: AdaptiveThresholds;
	/** Tool call count in current minute window (for adaptive tracking) */
	private toolCallsThisMinute = 0;
	/** Last minute window start time */
	private minuteWindowStart = 0;
	private readonly clock: Clock;
	private readonly sessionTokenCounter?: SessionTokenCounter;
	private readonly auditLogger?: ToolAuditLogger;

	/**
	 * Rate Limit Window - time window for counting tool invocations
	 * 10 seconds balances burst protection with legitimate rapid use
	 */
	private static readonly TOOL_RATE_WINDOW_MS = 10_000;

	/**
	 * Rate Limit Maximum - max calls per tool within the window
	 * 5 calls in 10 seconds allows fast iteration while preventing abuse
	 */
	private static readonly TOOL_RATE_LIMIT = 5;

	constructor(private options: ProviderTransportOptions = {}) {
		this.clock = options.clock ?? systemClock;
		this.sessionTokenCounter = options.sessionTokenCounter;
		this.auditLogger = options.auditLogger;
		this.minuteWindowStart = this.clock.now();
		// Initialize adaptive thresholds for anomaly detection
		this.adaptiveThresholds = new AdaptiveThresholds({
			alpha: 0.3, // Give more weight to recent observations
			anomalyThreshold: 2.5, // 2.5 std devs = more aggressive anomaly detection
			minObservations: 5, // Need at least 5 observations before anomaly detection
		});
		// Initialize safety middleware for unified security checks
		this.safetyMiddleware = createSafetyMiddleware({
			// Enable loop detection (replaces transport's doom loop detection)
			enableLoopDetection: true,
			// Configure loop detector to match transport's previous behavior
			loopDetector: {
				maxIdenticalCalls: 3, // Match DOOM_LOOP_THRESHOLD
				maxSimilarCalls: 5,
				maxCallsPerMinute: 30, // More aggressive rate limit than TOOL_RATE_LIMIT
				autoPause: false, // Transport handles the pause flow
			},
			// Enable sequence analysis for behavioral threat detection
			enableSequenceAnalysis: true,
			// Enable context firewall with blocking for sanitizing audit logs
			enableContextFirewall: true,
			// Configure context firewall blocking (can be disabled via MAESTRO_CONTEXT_FIREWALL_BLOCKING=0)
			contextFirewall: {
				// When blocking is disabled, vault credentials so test keys can pass through safely.
				vaultCredentials: !isContextFirewallBlockingEnabled(),
				blocking: {
					enabled: isContextFirewallBlockingEnabled(),
				},
			},
		});
	}

	/**
	 * Continue from current context without a new user message.
	 *
	 * This method reuses the run() logic but skips adding a new user message.
	 * Useful for:
	 * - Retrying after transient errors (rate limits, overload, 5xx)
	 * - Continuing after context compaction
	 * - Resuming interrupted tool execution
	 *
	 * @param messages - Current conversation history
	 * @param config - Runtime configuration
	 * @param signal - Optional abort signal for cancellation
	 * @returns Async iterable of agent events
	 */
	async *continue(
		messages: Message[],
		config: AgentRunConfig,
		signal?: AbortSignal,
	): AsyncGenerator<AgentEvent, void, unknown> {
		// Create a synthetic "continuation" message that signals we're resuming
		// This doesn't get added to the conversation but satisfies the run() interface
		const continuationMessage: Message = {
			role: "user",
			content: [
				{ type: "text", text: "[System: Continuing from previous context]" },
			],
			timestamp: this.clock.now(),
		};

		// Delegate to run() - the continuation message is used internally
		// but the actual context comes from the messages array
		yield* this.run(messages, continuationMessage, config, signal);
	}

	async *run(
		messages: Message[],
		userMessage: Message,
		cfg: AgentRunConfig,
		signal?: AbortSignal,
	): AsyncGenerator<AgentEvent, void, unknown> {
		const { systemPrompt, tools } = cfg;
		let model = cfg.model;
		const firewall = defaultActionFirewall;

		// Configure semantic judge if LLM access is provided
		if (cfg.runLLM) {
			firewall.setSemanticJudge(new SemanticJudge(cfg.runLLM));
		}

		// Initialize hook service for tool lifecycle hooks
		const hookService =
			this.options.hookService ??
			(this.options.cwd
				? createToolHookService({
						cwd: this.options.cwd,
						sessionId: cfg.session?.id,
						resolveTool: (toolName) =>
							cfg.tools?.find((tool) => tool.name === toolName),
					})
				: undefined);

		this.workflowState.reset();

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
		if (cfg.emitUserMessageEnd !== false) {
			yield { type: "message_end", message: userMessage };
		}

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

		const trainingHeaders = getTrainingHeaders();
		const headers =
			trainingHeaders || model.headers || credential?.headers
				? {
						...(model.headers ?? {}),
						...(trainingHeaders ?? {}),
						...(credential?.headers ?? {}),
					}
				: undefined;

		const streamOptions = {
			apiKey,
			maxTokens: model.maxTokens,
			signal,
			authType: credential?.type ?? "api-key",
			headers,
			requestBody: credential?.requestBody,
			taskBudget: cfg.taskBudget,
		};

		let hasMoreToolCalls = true;
		const allMessages = [...context.messages];
		const getSteeringMessages =
			cfg.getSteeringMessages ?? cfg.getQueuedMessages;
		const getFollowUpMessages = cfg.getFollowUpMessages;
		const getPromptOnlyMessages = cfg.getPromptOnlyMessages;

		let pendingMessages = getSteeringMessages
			? await getSteeringMessages<AppMessage>()
			: [];

		while (hasMoreToolCalls || pendingMessages.length > 0) {
			yield { type: "turn_start" };

			// Enforce session limits before every turn (duration + tokens)
			if (cfg.session) {
				let tokenCount: number | undefined;
				if (this.sessionTokenCounter) {
					try {
						const count = await this.sessionTokenCounter(cfg.session.id);
						if (count !== null) {
							tokenCount = count;
						}
					} catch (err) {
						// Log error but don't throw - let checkSessionLimits handle it.
						// If limits are active, it will fail closed because tokenCount is undefined.
						// If no limits are active, we shouldn't block just because tracking failed.
						logger.error(
							"Failed to get session token count",
							err instanceof Error ? err : new Error(String(err)),
						);
					}
				}

				const limitCheck = checkSessionLimits(cfg.session, {
					tokenCount: tokenCount,
				});
				if (!limitCheck.allowed) {
					throw new Error(limitCheck.reason);
				}
			}

			if (getPromptOnlyMessages) {
				const promptOnlyMessages = await getPromptOnlyMessages();
				if (promptOnlyMessages.length > 0) {
					allMessages.push(...promptOnlyMessages);
				}
			}

			if (pendingMessages.length > 0) {
				for (const queued of pendingMessages) {
					yield { type: "message_start", message: queued.original };
					yield { type: "message_end", message: queued.original };
					if (queued.llm) {
						allMessages.push(queued.llm);
					}
				}
				pendingMessages = [];
			}

			let currentAssistantMessage: AssistantMessage | null = null;
			let completedAssistantMessage: AssistantMessage | null = null;
			const toolCallsToExecute: ToolCall[] = [];
			let toolResults: ToolResultMessage[] = [];
			let steeringAfterTools: QueuedMessage<AppMessage>[] | null = null;
			let pendingNextTurn = false;
			let encounteredError = false;

			const currentMessages = cfg.preprocessMessages
				? await cfg.preprocessMessages(
						allMessages,
						{
							systemPrompt,
							tools,
							model,
							userMessage,
						},
						signal,
					)
				: allMessages;

			const currentContext = {
				...context,
				messages: currentMessages,
			};

			// Stream retry logic for idle timeouts
			const networkConfig = getProviderNetworkConfig(model.provider);
			const maxStreamRetries = networkConfig.streamMaxRetries;
			let streamAttempt = 0;
			let streamSuccess = false;

			while (!streamSuccess && streamAttempt <= maxStreamRetries) {
				if (streamAttempt > 0) {
					// Reset state for retry
					currentAssistantMessage = null;
					toolCallsToExecute.length = 0;
					pendingNextTurn = false;

					const backoffMs = Math.min(
						networkConfig.backoffInitial * 2 ** (streamAttempt - 1),
						networkConfig.backoffMax,
					);
					logger.info("Retrying stream after idle timeout", {
						attempt: streamAttempt,
						maxRetries: maxStreamRetries,
						backoffMs,
						provider: model.provider,
					});
					await new Promise((resolve) => setTimeout(resolve, backoffMs));
				}
				streamAttempt++;

				const stream = createProviderStream(
					model,
					currentContext,
					streamOptions,
					{ reasoning: cfg.reasoning, reasoningSummary: cfg.reasoningSummary },
				);

				try {
					for await (const event of stream) {
						if (event.type === "start") {
							currentAssistantMessage = event.partial;
							if (currentAssistantMessage) {
								yield {
									type: "message_start",
									message: currentAssistantMessage,
								};
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
								rawArgs &&
								typeof rawArgs === "object" &&
								!Array.isArray(rawArgs)
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
									const cost = model.cost
										? calculateCost(usage, model.cost)
										: 0;
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
											logger.warn("Failed to track usage", {
												error:
													error instanceof Error
														? error.message
														: String(error),
												stack: error instanceof Error ? error.stack : undefined,
											});
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
					streamSuccess = true;
				} catch (error) {
					if (
						isStreamIdleTimeoutError(error) &&
						streamAttempt <= maxStreamRetries
					) {
						logger.warn("Stream idle timeout, will retry", {
							attempt: streamAttempt,
							maxRetries: maxStreamRetries,
							provider: model.provider,
							idleMs: error.idleMs,
						});
						continue; // Retry the stream
					}
					// Not retryable or exhausted retries - re-throw
					throw error;
				}
			} // end while retry loop

			if (toolCallsToExecute.length > 0) {
				toolResults = [];
				const toolUpdateQueue = createToolUpdateQueue();
				const pendingExecutions: PendingExecution[] = [];
				const rawConcurrency = this.options.maxConcurrentToolExecutions ?? 2;
				const configuredConcurrency = Number.isFinite(rawConcurrency)
					? Math.max(1, Math.floor(rawConcurrency))
					: 2;
				const hasWorkflowTrackedTool = toolCallsToExecute.some((call) =>
					isWorkflowTrackedTool(call.name),
				);
				const requiresSerializedTurn =
					hasWorkflowTrackedTool && toolCallsToExecute.length > 1;

				// Calculate optimal concurrency - higher for read-only batches
				let concurrencyLimit = getOptimalConcurrency(
					toolCallsToExecute,
					tools,
					{
						baseConcurrency: configuredConcurrency,
						maxReadOnlyConcurrency: 8, // Allow up to 8x parallel for read-only
						enabled: true,
					},
				);

				// Override: workflow-tracked tools require serialization
				if (configuredConcurrency > 1 && requiresSerializedTurn) {
					concurrencyLimit = 1;
					if (!this.warnedAboutWorkflowConcurrency) {
						logger.warn(
							"WorkflowStateTracker requires serialized tool execution; maxConcurrentToolExecutions capped at 1",
						);
						this.warnedAboutWorkflowConcurrency = true;
					}
				}

				let steeringTriggered = false;
				let remainingToolCalls: ToolCall[] = [];

				const checkSteering = async (): Promise<void> => {
					if (steeringTriggered || !getSteeringMessages) {
						return;
					}
					const steering = await getSteeringMessages<AppMessage>();
					if (steering.length > 0) {
						steeringTriggered = true;
						steeringAfterTools = steering;
					}
				};

				const buildExecutionEvents = (
					toolCall: ToolCall,
					message: ToolResultMessage,
					isError: boolean,
					metadata?: {
						toolExecutionId?: string;
						approvalRequestId?: string;
					},
				): AgentEvent[] => [
					{ type: "message_start", message } as AgentEvent,
					{ type: "message_end", message } as AgentEvent,
					{
						type: "tool_execution_end",
						toolCallId: toolCall.id,
						toolExecutionId: metadata?.toolExecutionId,
						approvalRequestId: metadata?.approvalRequestId,
						toolName: toolCall.name,
						result: message,
						isError,
					} as AgentEvent,
				];
				const emitToolResult = (
					message: ToolResultMessage,
					toolCall: ToolCall,
					isError: boolean,
					metadata?: {
						toolExecutionId?: string;
						approvalRequestId?: string;
					},
				) => {
					try {
						applyWorkflowStateHooks({
							toolCall,
							result: message,
							tracker: this.workflowState,
							isError,
						});
						toolResults.push(message);
						return buildExecutionEvents(toolCall, message, isError, metadata);
					} catch (error) {
						if (error instanceof WorkflowStateError) {
							const workflowErrorResult: ToolResultMessage = {
								role: "toolResult",
								toolCallId: toolCall.id,
								toolName: toolCall.name,
								content: [{ type: "text", text: error.message }],
								isError: true,
								timestamp: this.clock.now(),
							};
							toolResults.push(workflowErrorResult);
							return buildExecutionEvents(
								toolCall,
								workflowErrorResult,
								true,
								metadata,
							);
						}
						throw error;
					}
				};
				const emitSkippedToolCall = (toolCall: ToolCall): AgentEvent[] => {
					const sanitizedSkippedArgs = this.safetyMiddleware.sanitizeForLogging(
						toolCall.arguments as Record<string, unknown>,
					);
					const skippedResult: ToolResultMessage = {
						role: "toolResult",
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						content: [
							{
								type: "text",
								text: "Skipped due to queued user message.",
							},
						],
						isError: true,
						timestamp: this.clock.now(),
					};
					return [
						{
							type: "tool_execution_start",
							toolCallId: toolCall.id,
							toolName: toolCall.name,
							args: sanitizedSkippedArgs,
						} as AgentEvent,
						...emitToolResult(skippedResult, toolCall, true),
					];
				};

				const scheduleResolveIfNeeded = async (): Promise<AgentEvent[]> => {
					if (pendingExecutions.length < concurrencyLimit) {
						return [];
					}
					const events: AgentEvent[] = [];
					while (pendingExecutions.length >= concurrencyLimit) {
						const next = await waitForNextExecutionOrUpdate(
							pendingExecutions,
							toolUpdateQueue,
						);
						if (next.kind === "update") {
							events.push(next.event);
							continue;
						}
						const outcome = next.outcome;
						events.push(
							...emitToolResult(
								outcome.message,
								next.execution.toolCall,
								outcome.isError,
								{
									toolExecutionId: outcome.toolExecutionId,
									approvalRequestId: outcome.approvalRequestId,
								},
							),
						);
						await checkSteering();
						break;
					}
					return events;
				};

				for (
					let toolIndex = 0;
					toolIndex < toolCallsToExecute.length;
					toolIndex++
				) {
					if (steeringTriggered) {
						remainingToolCalls = toolCallsToExecute.slice(toolIndex);
						break;
					}
					const toolCall = toolCallsToExecute[toolIndex];
					if (!toolCall) continue;

					// Run safety pipeline (rate limiting, hooks, firewall, approval, validation)
					const safetyIterator = evaluateToolSafety({
						toolCall,
						tools,
						userMessage,
						cfg,
						signal,
						clock: this.clock,
						safetyMiddleware: this.safetyMiddleware,
						workflowState: this.workflowState,
						adaptiveThresholds: this.adaptiveThresholds,
						auditLogger: this.auditLogger,
						approvalService: this.options.approvalService,
						toolExecutionBridge:
							this.options.platformToolExecutionBridge === false
								? undefined
								: (this.options.platformToolExecutionBridge ??
									getDefaultPlatformToolExecutionBridge()),
						hookService,
						firewall,
						rateLimitState: {
							recentToolTimestamps: this.recentToolTimestamps,
							toolCallsThisMinute: this.toolCallsThisMinute,
							minuteWindowStart: this.minuteWindowStart,
							rateWindowMs: ProviderTransport.TOOL_RATE_WINDOW_MS,
							rateLimit: ProviderTransport.TOOL_RATE_LIMIT,
						},
						emitToolResult,
					});
					let safetyVerdict: ToolSafetyVerdict | undefined;
					let rateLimitUpdate:
						| { toolCallsThisMinute: number; minuteWindowStart: number }
						| undefined;
					while (true) {
						const safetyStep = await safetyIterator.next();
						if (safetyStep.done) {
							({ verdict: safetyVerdict, rateLimitUpdate } = safetyStep.value);
							break;
						}
						yield safetyStep.value;
					}
					if (!safetyVerdict || !rateLimitUpdate) {
						throw new Error("Safety pipeline did not return a verdict.");
					}

					// Apply rate limit state updates
					this.toolCallsThisMinute = rateLimitUpdate.toolCallsThisMinute;
					this.minuteWindowStart = rateLimitUpdate.minuteWindowStart;

					if (safetyVerdict.outcome === "blocked") {
						await checkSteering();
						if (steeringTriggered) {
							remainingToolCalls = toolCallsToExecute.slice(toolIndex + 1);
							break;
						}
						continue;
					}

					const {
						effectiveToolCall,
						validatedArgs,
						toolDef: tool,
						sanitizedExecutionArgs,
					} = safetyVerdict;
					// Use hook-modified (pre-validation) args for hook inputs

					// For client tools, set up the execution promise first, then emit event
					// This prevents race conditions where the client responds before we're listening
					let clientToolExecPromise:
						| ReturnType<ClientToolExecutionService["requestExecution"]>
						| undefined;
					if (
						tool.executionLocation === "client" &&
						this.options.clientToolService
					) {
						clientToolExecPromise =
							this.options.clientToolService.requestExecution(
								toolCall.id,
								toolCall.name,
								validatedArgs,
								signal,
							);
						// Now emit the event - the promise is already waiting for the result
						yield {
							type: "client_tool_request",
							toolCallId: toolCall.id,
							toolName: toolCall.name,
							// Client tools execute out-of-process; they need the real args.
							args: validatedArgs,
						};
					}

					const executionPromise = createToolExecutionPromise({
						toolCall,
						effectiveToolCall,
						tool,
						validatedArgs,
						sanitizedExecutionArgs,
						cfg,
						signal,
						clock: this.clock,
						safetyMiddleware: this.safetyMiddleware,
						adaptiveThresholds: this.adaptiveThresholds,
						auditLogger: this.auditLogger,
						hookService,
						toolRetryService: this.options.toolRetryService,
						toolRetryConfig: this.options.toolRetryConfig,
						clientToolService: this.options.clientToolService,
						toolExecutionBridge:
							this.options.platformToolExecutionBridge === false
								? undefined
								: (this.options.platformToolExecutionBridge ??
									getDefaultPlatformToolExecutionBridge()),
						toolExecutionBridgePlan: safetyVerdict.toolExecutionBridgePlan,
						toolUpdateQueue,
						clientToolExecPromise,
					});

					pendingExecutions.push({
						toolCall,
						promise: executionPromise,
					});
					const events = await scheduleResolveIfNeeded();
					for (const event of events) {
						yield event;
					}
					if (steeringTriggered) {
						remainingToolCalls = toolCallsToExecute.slice(toolIndex + 1);
						break;
					}
				}

				while (pendingExecutions.length > 0) {
					const next = await waitForNextExecutionOrUpdate(
						pendingExecutions,
						toolUpdateQueue,
					);
					if (next.kind === "update") {
						yield next.event;
						continue;
					}
					const outcome = next.outcome;
					for (const event of emitToolResult(
						outcome.message,
						next.execution.toolCall,
						outcome.isError,
						{
							toolExecutionId: outcome.toolExecutionId,
							approvalRequestId: outcome.approvalRequestId,
						},
					)) {
						yield event;
					}
					await checkSteering();
				}

				this.safetyMiddleware.clearCredentials();

				if (steeringTriggered && remainingToolCalls.length > 0) {
					for (const toolCall of remainingToolCalls) {
						for (const event of emitSkippedToolCall(toolCall)) {
							yield event;
						}
					}
				}

				if (!steeringTriggered && getSteeringMessages) {
					const steering = await getSteeringMessages<AppMessage>();
					if (steering.length > 0) {
						steeringAfterTools = steering;
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
						timestamp: this.clock.now(),
					},
				toolResults,
			};

			if (steeringAfterTools && steeringAfterTools.length > 0) {
				pendingMessages = steeringAfterTools;
			} else if (getSteeringMessages) {
				const steering = await getSteeringMessages<AppMessage>();
				if (steering.length > 0) {
					pendingMessages = steering;
				}
			}

			if (
				!pendingNextTurn &&
				pendingMessages.length === 0 &&
				getFollowUpMessages
			) {
				const followUps = await getFollowUpMessages<AppMessage>();
				if (followUps.length > 0) {
					pendingMessages = followUps;
				}
			}

			if (pendingMessages.length > 0) {
				pendingNextTurn = true;
			}

			hasMoreToolCalls = encounteredError ? false : pendingNextTurn;
		}
	}
}
