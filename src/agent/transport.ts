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
import { envApiKeyMap } from "../providers/api-keys.js";
import { getProviderNetworkConfig } from "../providers/network-config.js";
import { isStreamIdleTimeoutError } from "../providers/stream-idle-timeout.js";
import { type Clock, systemClock } from "../utils/clock.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("transport");
import type { AuthCredential } from "../providers/auth.js";
import {
	HUMAN_EGRESS_PII_RULE_ID,
	defaultActionFirewall,
} from "../safety/action-firewall.js";
import { AdaptiveThresholds, METRICS } from "../safety/adaptive-thresholds.js";
import { sanitizeLogMessage } from "../safety/context-firewall.js";
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
import { trackToolBlocked } from "../telemetry/security-events.js";
import { getOptimalConcurrency } from "../tools/parallel-execution.js";
import { ToolError } from "../tools/tool-dsl.js";
import { trackUsage } from "../tracking/cost-tracker.js";
import { getTrainingHeaders } from "../training.js";
import type {
	ActionApprovalService,
	WorkflowStateSnapshot,
} from "./action-approval.js";
import { getStoredCredentials } from "./keys.js";
import { streamAnthropic } from "./providers/anthropic.js";
import { streamBedrock } from "./providers/bedrock.js";
import { streamGoogleGeminiCli } from "./providers/google-gemini-cli.js";
import { streamGoogle } from "./providers/google.js";
import { streamOpenAI } from "./providers/openai.js";
import { validateToolArguments } from "./providers/validation.js";
import type {
	AgentEvent,
	AgentRunConfig,
	AgentToolResult,
	AgentTransport,
	AppMessage,
	AssistantMessage,
	AssistantMessageEvent,
	Message,
	Model,
	QueuedMessage,
	ToolCall,
	ToolResultMessage,
} from "./types.js";

interface ToolExecutionOutcome {
	message: ToolResultMessage;
	isError: boolean;
}

export type SessionTokenCounter = (sessionId: string) => Promise<number | null>;

export type ToolAuditLogger = (entry: {
	toolName: string;
	args: Record<string, unknown>;
	status: "success" | "failure" | "denied";
	durationMs: number;
	error?: string;
}) => Promise<void>;

export interface ClientToolExecutionService {
	requestExecution: (
		id: string,
		toolName: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	) => Promise<{ content: AgentToolResult["content"]; isError: boolean }>;
}

/**
 * Extract text content from a message content field.
 * Handles both string format and array format (multimodal messages).
 *
 * This is critical for semantic safety analysis - without this, multimodal
 * messages would bypass intent extraction and skip the semantic judge.
 */
function extractTextFromContent(
	content: string | { type: string; text?: string }[] | undefined,
): string | undefined {
	if (!content) return undefined;

	// Simple string content
	if (typeof content === "string") {
		return content;
	}

	// Array content (multimodal) - extract text from all text blocks
	if (Array.isArray(content)) {
		const textParts: string[] = [];
		for (const block of content) {
			if (
				typeof block === "object" &&
				block !== null &&
				block.type === "text" &&
				typeof block.text === "string"
			) {
				textParts.push(block.text);
			}
		}
		return textParts.length > 0 ? textParts.join("\n") : undefined;
	}

	return undefined;
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

// Sensitive tools that should be logged for audit purposes
const SENSITIVE_TOOLS = new Set([
	"bash",
	"background_tasks",
	"write",
	"edit",
	"git_cmd",
	"gh_pr",
	"gh_issue",
	"websearch",
	"webfetch",
]);

async function logToolExecutionAudit(
	auditLogger: ToolAuditLogger | undefined,
	toolName: string,
	args: Record<string, unknown>,
	status: "success" | "failure" | "denied",
	durationMs: number,
	error?: string,
): Promise<void> {
	// Only log sensitive tools and only if enterprise features are available
	if (!SENSITIVE_TOOLS.has(toolName) || !auditLogger) {
		return;
	}

	try {
		const sanitizedError = error ? sanitizeLogMessage(error) : undefined;
		await auditLogger({
			toolName,
			args,
			status,
			durationMs,
			error: sanitizedError,
		});
	} catch (err) {
		// Log audit failures but fail open (allow legitimate use) per user feedback
		logger.error(
			"Failed to log tool execution",
			err instanceof Error ? err : new Error(String(err)),
			{ toolName },
		);
	}
}

/**
 * Calculate API Cost from Token Usage
 *
 * Computes the total cost of an LLM request based on token counts and
 * per-token pricing. Costs are specified in dollars per million tokens
 * (the standard industry format), so we divide by 1,000,000.
 *
 * ## Cost Components
 *
 * - **Input tokens**: Tokens in the prompt (system prompt + messages + tools)
 * - **Output tokens**: Tokens generated by the model
 * - **Cache read**: Tokens loaded from prompt cache (usually cheaper)
 * - **Cache write**: Tokens written to prompt cache (may have different pricing)
 *
 * ## Example Calculation
 *
 * For Claude Sonnet with input=$3/M, output=$15/M:
 * - 10,000 input tokens = 10000 * 3 / 1,000,000 = $0.03
 * - 1,000 output tokens = 1000 * 15 / 1,000,000 = $0.015
 * - Total = $0.045
 *
 * @param usage - Token counts from the API response
 * @param costConfig - Per-million-token pricing for each usage type
 * @returns Total cost in dollars
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
	// Each cost component: (tokens * dollars_per_million) / 1_000_000
	const inputCost = ((usage.input || 0) * costConfig.input) / 1_000_000;
	const outputCost = ((usage.output || 0) * costConfig.output) / 1_000_000;
	const cacheReadCost =
		((usage.cacheRead || 0) * costConfig.cacheRead) / 1_000_000;
	const cacheWriteCost =
		((usage.cacheWrite || 0) * costConfig.cacheWrite) / 1_000_000;

	return inputCost + outputCost + cacheReadCost + cacheWriteCost;
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
	clock: Clock,
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
		timestamp: clock.now(),
	};
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
			// Configure context firewall blocking (can be disabled via COMPOSER_CONTEXT_FIREWALL_BLOCKING=0)
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
			trainingHeaders || model.headers
				? { ...(model.headers ?? {}), ...(trainingHeaders ?? {}) }
				: undefined;

		const streamOptions = {
			apiKey,
			maxTokens: model.maxTokens,
			signal,
			authType: credential?.type ?? "api-key",
			headers,
		};

		let hasMoreToolCalls = true;
		const allMessages = [...context.messages];
		const getSteeringMessages =
			cfg.getSteeringMessages ?? cfg.getQueuedMessages;
		const getFollowUpMessages = cfg.getFollowUpMessages;

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

				let stream: AsyncGenerator<AssistantMessageEvent, void, unknown>;
				if (model.api === "anthropic-messages") {
					stream = streamAnthropic(
						model as Model<"anthropic-messages">,
						currentContext,
						{
							...streamOptions,
							thinking: cfg.reasoning,
						},
					);
				} else if (
					model.api === "openai-completions" ||
					model.api === "openai-responses"
				) {
					stream = streamOpenAI(
						model as Model<"openai-completions" | "openai-responses">,
						currentContext,
						{
							...streamOptions,
							reasoningEffort: cfg.reasoning,
							reasoningSummary: cfg.reasoningSummary,
						},
					);
				} else if (model.api === "google-generative-ai") {
					stream = streamGoogle(
						model as Model<"google-generative-ai">,
						currentContext,
						{
							...streamOptions,
							thinking: cfg.reasoning,
						},
					);
				} else if (model.api === "google-gemini-cli") {
					stream = streamGoogleGeminiCli(
						model as Model<"google-gemini-cli">,
						currentContext,
						{
							...streamOptions,
							thinking: cfg.reasoning,
						},
					);
				} else if (model.api === "bedrock-converse") {
					stream = streamBedrock(
						model as Model<"bedrock-converse">,
						currentContext,
						streamOptions,
					);
				} else {
					throw new Error(`Unsupported API: ${model.api}`);
				}

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
								timestamp: this.clock.now(),
							};
							toolResults.push(workflowErrorResult);
							return buildExecutionEvents(toolCall, workflowErrorResult, true);
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

					// Rate limiting check (doom loop detection is now handled by SafetyMiddleware)
					const now = this.clock.now();
					const timestamps = this.recentToolTimestamps.get(toolCall.name) ?? [];
					const recent = timestamps.filter(
						(ts) => now - ts < ProviderTransport.TOOL_RATE_WINDOW_MS,
					);

					// Track tool calls per minute for adaptive thresholds
					if (now - this.minuteWindowStart >= 60_000) {
						// Record the observation at minute boundary
						this.adaptiveThresholds.recordObservation(
							METRICS.TOOL_CALLS_PER_MINUTE,
							this.toolCallsThisMinute,
						);
						// Reset for new minute window
						this.toolCallsThisMinute = 0;
						this.minuteWindowStart = now;
					}
					this.toolCallsThisMinute++;

					// Track tool-specific metrics
					const toolNameLower = toolCall.name.toLowerCase();
					if (toolNameLower === "read" || toolNameLower === "glob") {
						this.adaptiveThresholds.recordObservation(
							METRICS.READS_PER_MINUTE,
							1,
						);
					} else if (toolNameLower === "write" || toolNameLower === "edit") {
						this.adaptiveThresholds.recordObservation(
							METRICS.WRITES_PER_MINUTE,
							1,
						);
					} else if (
						toolNameLower === "webfetch" ||
						toolNameLower === "websearch" ||
						toolNameLower.includes("mcp")
					) {
						this.adaptiveThresholds.recordObservation(
							METRICS.EGRESS_PER_MINUTE,
							1,
						);
					}

					// Check for anomalous tool call rate
					const anomalyCheck = this.adaptiveThresholds.checkAnomaly(
						METRICS.TOOL_CALLS_PER_MINUTE,
						this.toolCallsThisMinute,
					);

					// Enforce anomaly detection - block when anomaly detected
					if (anomalyCheck.isAnomaly) {
						trackToolBlocked({
							toolName: toolCall.name,
							reason: `Anomaly detected: ${anomalyCheck.reason ?? "Unusual tool call rate"}`,
							source: "adaptive",
						});
						const anomalyMessage: ToolResultMessage = {
							role: "toolResult",
							toolCallId: toolCall.id,
							toolName: toolCall.name,
							content: [
								{
									type: "text",
									text: `Blocked "${toolCall.name}" due to anomalous behavior: ${anomalyCheck.reason ?? "Unusual tool call pattern detected"}. Z-score: ${anomalyCheck.zScore.toFixed(2)}, Baseline: ${anomalyCheck.mean.toFixed(2)} ± ${anomalyCheck.stdDev.toFixed(2)}`,
								},
							],
							isError: true,
							timestamp: now,
						};
						for (const evt of emitToolResult(anomalyMessage, toolCall, true)) {
							yield evt;
						}
						await checkSteering();
						if (steeringTriggered) {
							remainingToolCalls = toolCallsToExecute.slice(toolIndex + 1);
							break;
						}
						continue;
					}

					// Use adaptive threshold if we have enough data, otherwise use static limit
					const effectiveRateLimit =
						this.adaptiveThresholds.getAdaptedThreshold(
							`tool_rate_${toolCall.name}`,
							ProviderTransport.TOOL_RATE_LIMIT,
						);

					if (recent.length >= effectiveRateLimit) {
						const rateMessage: ToolResultMessage = {
							role: "toolResult",
							toolCallId: toolCall.id,
							toolName: toolCall.name,
							content: [
								{
									type: "text",
									text: `Blocked "${toolCall.name}" due to rate limit: >${effectiveRateLimit} calls in ${ProviderTransport.TOOL_RATE_WINDOW_MS / 1000}s window.${
										anomalyCheck.isAnomaly
											? ` (Anomaly detected: ${anomalyCheck.reason})`
											: ""
									}`,
								},
							],
							isError: true,
							timestamp: now,
						};
						for (const evt of emitToolResult(rateMessage, toolCall, true)) {
							yield evt;
						}
						await checkSteering();
						if (steeringTriggered) {
							remainingToolCalls = toolCallsToExecute.slice(toolIndex + 1);
							break;
						}
						continue;
					}

					// Record observation for per-tool adaptive rate
					this.adaptiveThresholds.recordObservation(
						`tool_rate_${toolCall.name}`,
						recent.length,
					);

					recent.push(now);
					this.recentToolTimestamps.set(toolCall.name, recent);
					const sanitizedStartArgs = this.safetyMiddleware.sanitizeForLogging(
						toolCall.arguments as Record<string, unknown>,
					);

					yield {
						type: "tool_execution_start",
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						args: sanitizedStartArgs,
					};

					// Run PreToolUse hooks before firewall check
					let effectiveToolCall = toolCall;
					if (hookService) {
						const hookResult = await hookService.runPreToolUseHooks(
							toolCall,
							signal,
						);

						// Check if hook blocked execution
						if (hookResult.blocked) {
							const hookBlockedResult: ToolResultMessage = {
								role: "toolResult",
								toolCallId: toolCall.id,
								toolName: toolCall.name,
								content: [
									{
										type: "text",
										text: `Blocked by hook: ${hookResult.blockReason ?? "Hook denied execution"}`,
									},
								],
								isError: true,
								timestamp: this.clock.now(),
							};
							await logToolExecutionAudit(
								this.auditLogger,
								toolCall.name,
								this.safetyMiddleware.sanitizeForLogging(
									toolCall.arguments as Record<string, unknown>,
								),
								"denied",
								0,
								hookResult.blockReason,
							);
							for (const event of emitToolResult(
								hookBlockedResult,
								toolCall,
								true,
							)) {
								yield event;
							}
							await checkSteering();
							if (steeringTriggered) {
								remainingToolCalls = toolCallsToExecute.slice(toolIndex + 1);
								break;
							}
							continue;
						}

						// Apply updated input from hook if provided
						if (hookResult.updatedInput) {
							effectiveToolCall = {
								...toolCall,
								arguments: hookResult.updatedInput,
							};
							logger.debug("Hook modified tool input", {
								toolName: toolCall.name,
								originalArgs: Object.keys(toolCall.arguments),
								updatedArgs: Object.keys(hookResult.updatedInput),
							});
						}
					}

					// Run safety middleware sequence analysis
					const safetyCheck = this.safetyMiddleware.preExecution(
						effectiveToolCall.name,
						effectiveToolCall.arguments as Record<string, unknown>,
					);

					if (!safetyCheck.allowed && !safetyCheck.requiresApproval) {
						// Hard block from safety middleware
						const safetyBlockedResult: ToolResultMessage = {
							role: "toolResult",
							toolCallId: toolCall.id,
							toolName: toolCall.name,
							content: [
								{
									type: "text",
									text: `Blocked by safety check: ${safetyCheck.reason ?? "Safety policy violation"}`,
								},
							],
							isError: true,
							timestamp: this.clock.now(),
						};
						await logToolExecutionAudit(
							this.auditLogger,
							toolCall.name,
							safetyCheck.sanitizedArgs,
							"denied",
							0,
							safetyCheck.reason,
						);
						for (const event of emitToolResult(
							safetyBlockedResult,
							toolCall,
							true,
						)) {
							yield event;
						}
						await checkSteering();
						if (steeringTriggered) {
							remainingToolCalls = toolCallsToExecute.slice(toolIndex + 1);
							break;
						}
						continue;
					}

					let approvalAllowed = true;
					let approvalReason: string | undefined;

					// Check if safety middleware requires approval
					if (safetyCheck.requiresApproval) {
						approvalAllowed = false;
						approvalReason = safetyCheck.reason;
					}

					const workflowSnapshot = this.workflowState.snapshot();
					// Look up tool to get annotations for firewall decisions
					const toolDef = tools.find((t) => t.name === effectiveToolCall.name);
					const verdict = await firewall.evaluate({
						toolName: effectiveToolCall.name,
						args: effectiveToolCall.arguments,
						metadata: {
							workflowState: workflowSnapshot,
							annotations: toolDef?.annotations,
						},
						user: cfg.user,
						session: cfg.session,
						// Extract user intent from message content (supports both string and array formats)
						userIntent: extractTextFromContent(userMessage.content),
					});

					if (verdict.action === "block") {
						const blockedResult: ToolResultMessage = {
							role: "toolResult",
							toolCallId: toolCall.id,
							toolName: toolCall.name,
							content: [
								{
									type: "text",
									text: `Action blocked by firewall: ${verdict.reason}${
										verdict.remediation
											? `\n\nSuggestion: ${verdict.remediation}`
											: ""
									}`,
								},
							],
							isError: true,
							timestamp: this.clock.now(),
						};

						// Log denied tool execution for audit
						await logToolExecutionAudit(
							this.auditLogger,
							toolCall.name,
							this.safetyMiddleware.sanitizeForLogging(
								toolCall.arguments as Record<string, unknown>,
							),
							"denied",
							0,
							verdict.reason,
						);

						for (const event of emitToolResult(blockedResult, toolCall, true)) {
							yield event;
						}
						await checkSteering();
						if (steeringTriggered) {
							remainingToolCalls = toolCallsToExecute.slice(toolIndex + 1);
							break;
						}
						continue;
					}

					if (
						verdict.action === "require_approval" &&
						verdict.ruleId === HUMAN_EGRESS_PII_RULE_ID
					) {
						const policyResult = buildPiiPolicyResult(
							toolCall,
							workflowSnapshot,
							this.clock,
						);
						for (const event of emitToolResult(policyResult, toolCall, true)) {
							yield event;
						}
						await checkSteering();
						if (steeringTriggered) {
							remainingToolCalls = toolCallsToExecute.slice(toolIndex + 1);
							break;
						}
						continue;
					}
					if (verdict.action === "require_approval") {
						const approvalService = this.options.approvalService;
						if (approvalService) {
							const sanitizedApprovalArgs =
								this.safetyMiddleware.sanitizeForLogging(
									effectiveToolCall.arguments as Record<string, unknown>,
								);
							const request = {
								id: toolCall.id,
								toolName: toolCall.name,
								args: sanitizedApprovalArgs,
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
						// Log denied tool execution for audit
						await logToolExecutionAudit(
							this.auditLogger,
							toolCall.name,
							this.safetyMiddleware.sanitizeForLogging(
								toolCall.arguments as Record<string, unknown>,
							),
							"denied",
							0,
							approvalReason,
						);

						const deniedResult: ToolResultMessage = {
							role: "toolResult",
							toolCallId: toolCall.id,
							toolName: toolCall.name,
							content: [
								{ type: "text", text: approvalReason ?? "Action denied" },
							],
							isError: true,
							timestamp: this.clock.now(),
						};
						for (const event of emitToolResult(deniedResult, toolCall, true)) {
							yield event;
						}
						await checkSteering();
						if (steeringTriggered) {
							remainingToolCalls = toolCallsToExecute.slice(toolIndex + 1);
							break;
						}
						continue;
					}

					// Use toolDef from earlier lookup
					if (!toolDef) {
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
							timestamp: this.clock.now(),
						};
						for (const event of emitToolResult(errorResult, toolCall, true)) {
							yield event;
						}
						await checkSteering();
						if (steeringTriggered) {
							remainingToolCalls = toolCallsToExecute.slice(toolIndex + 1);
							break;
						}
						continue;
					}
					const tool = toolDef;

					let validatedArgs: Record<string, unknown>;
					try {
						// Validate the raw (hook-modified) arguments to preserve schema expectations
						const rawArgs = validateToolArguments(tool, effectiveToolCall);
						const vaultedArgs =
							this.safetyMiddleware.prepareExecutionArgs(rawArgs);
						// Resolve any credential references (e.g., {{CRED:api_key:abc123}}) to actual values
						// This allows the agent to use vaulted credentials in tool execution
						validatedArgs =
							this.safetyMiddleware.resolveCredentials(vaultedArgs);
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
							timestamp: this.clock.now(),
						};
						for (const event of emitToolResult(
							validationErrorResult,
							toolCall,
							true,
						)) {
							yield event;
						}
						await checkSteering();
						if (steeringTriggered) {
							remainingToolCalls = toolCallsToExecute.slice(toolIndex + 1);
							break;
						}
						continue;
					}
					const sanitizedExecutionArgs =
						this.safetyMiddleware.sanitizeForLogging(validatedArgs);

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

					const startTime = this.clock.now();
					const executionPromise: Promise<ToolExecutionOutcome> =
						Promise.resolve()
							.then(() => {
								if (tool.executionLocation === "client") {
									if (!clientToolExecPromise) {
										throw new Error(
											`Client tool execution service not configured for tool "${tool.name}"`,
										);
									}
									return clientToolExecPromise.then(
										(res) =>
											({
												content: res.content,
												isError: res.isError,
												details: undefined,
											}) as AgentToolResult,
									);
								}
								const context = cfg.sandbox
									? { sandbox: cfg.sandbox }
									: undefined;
								const onUpdate = (partialResult: AgentToolResult) => {
									toolUpdateQueue.push({
										type: "tool_execution_update",
										toolCallId: toolCall.id,
										toolName: toolCall.name,
										args: sanitizedExecutionArgs,
										partialResult,
									});
								};
								return tool.execute(
									toolCall.id,
									validatedArgs,
									signal,
									context,
									onUpdate,
								);
							})

							.then(async (result) => {
								// Log tool execution - check isError flag for correct status
								await logToolExecutionAudit(
									this.auditLogger,
									toolCall.name,
									sanitizedExecutionArgs,
									result.isError ? "failure" : "success",
									this.clock.now() - startTime,
								);

								// Record execution in safety middleware for sequence analysis
								this.safetyMiddleware.postExecution(
									toolCall.name,
									validatedArgs,
									!result.isError,
									true, // approved
								);

								// Track failure rate for adaptive thresholds
								this.adaptiveThresholds.recordObservation(
									METRICS.FAILURE_RATE,
									result.isError ? 1 : 0,
								);

								const toolResultMsg: ToolResultMessage = {
									role: "toolResult" as const,
									toolCallId: toolCall.id,
									toolName: toolCall.name,
									content: result.content,
									details: result.details,
									isError: result.isError || false,
									timestamp: this.clock.now(),
								};

								// Run PostToolUse hooks for successful execution
								if (hookService && !result.isError) {
									const postHookResult = await hookService.runPostToolUseHooks(
										effectiveToolCall,
										toolResultMsg,
										signal,
									);
									// If hook adds context, append to result content
									if (postHookResult.additionalContext) {
										toolResultMsg.content = [
											...toolResultMsg.content,
											{
												type: "text" as const,
												text: `\n[Hook context]: ${postHookResult.additionalContext}`,
											},
										];
									}
									// If hook wants to prevent continuation, mark the result
									if (postHookResult.preventContinuation) {
										toolResultMsg.content = [
											...toolResultMsg.content,
											{
												type: "text" as const,
												text: `\n[Hook stop]: ${postHookResult.stopReason ?? "Hook requested stop"}`,
											},
										];
										toolResultMsg.isError = true;
									}
									// Merge assertions and evaluation into details
									if (
										postHookResult.assertions?.length ||
										postHookResult.evaluation
									) {
										const mergedDetails: Record<string, unknown> =
											toolResultMsg.details &&
											typeof toolResultMsg.details === "object"
												? {
														...(toolResultMsg.details as Record<
															string,
															unknown
														>),
													}
												: {};

										if (postHookResult.evaluation) {
											mergedDetails.evaluation = postHookResult.evaluation;
										}
										if (postHookResult.assertions?.length) {
											mergedDetails.assertions = postHookResult.assertions;
										}

										toolResultMsg.details =
											mergedDetails as typeof toolResultMsg.details;
									}

									const evalHookResult = await hookService.runEvalGateHooks(
										effectiveToolCall,
										toolResultMsg,
										signal,
									);

									if (evalHookResult.additionalContext) {
										toolResultMsg.content = [
											...toolResultMsg.content,
											{
												type: "text" as const,
												text: `\n[Hook context]: ${evalHookResult.additionalContext}`,
											},
										];
									}

									if (
										evalHookResult.assertions?.length ||
										evalHookResult.evaluation
									) {
										const mergedDetails: Record<string, unknown> =
											toolResultMsg.details &&
											typeof toolResultMsg.details === "object"
												? {
														...(toolResultMsg.details as Record<
															string,
															unknown
														>),
													}
												: {};

										// Only assign evaluation if it's actually defined and has content
										if (
											evalHookResult.evaluation &&
											Object.keys(evalHookResult.evaluation).length > 0
										) {
											mergedDetails.evaluation = evalHookResult.evaluation;
										}
										// Only assign assertions if they exist and have length
										if (evalHookResult.assertions?.length) {
											mergedDetails.assertions = evalHookResult.assertions;
										}

										toolResultMsg.details =
											mergedDetails as typeof toolResultMsg.details;
									}

									if (evalHookResult.preventContinuation) {
										toolResultMsg.content = [
											...toolResultMsg.content,
											{
												type: "text" as const,
												text: `\n[Hook stop]: ${evalHookResult.stopReason ?? "Hook requested stop"}`,
											},
										];
										toolResultMsg.isError = true;
									}
								}

								return {
									message: toolResultMsg,
									isError: toolResultMsg.isError,
								};
							})
							.catch(async (error: unknown) => {
								const errorMessage =
									error instanceof Error
										? error.message
										: `Error: ${String(error)}`;

								// Log failed tool execution
								await logToolExecutionAudit(
									this.auditLogger,
									toolCall.name,
									this.safetyMiddleware.sanitizeForLogging(validatedArgs),
									"failure",
									this.clock.now() - startTime,
									errorMessage,
								);

								// Record failure in safety middleware for sequence analysis
								this.safetyMiddleware.postExecution(
									toolCall.name,
									validatedArgs,
									false, // success
									true, // approved
								);

								// Track failure rate for adaptive thresholds (failure = 1)
								this.adaptiveThresholds.recordObservation(
									METRICS.FAILURE_RATE,
									1,
								);

								const toolResultMsg: ToolResultMessage = {
									role: "toolResult" as const,
									toolCallId: toolCall.id,
									toolName: toolCall.name,
									content: [
										{
											type: "text" as const,
											text: errorMessage,
										},
									],
									details:
										error instanceof ToolError ? error.details : undefined,
									isError: true,
									timestamp: this.clock.now(),
								};

								// Run PostToolUseFailure hooks
								if (hookService) {
									const failureHookResult =
										await hookService.runPostToolUseFailureHooks(
											effectiveToolCall,
											errorMessage,
											signal,
										);
									// If hook adds context, append to result content
									if (failureHookResult.additionalContext) {
										toolResultMsg.content = [
											...toolResultMsg.content,
											{
												type: "text" as const,
												text: `\n[Hook context]: ${failureHookResult.additionalContext}`,
											},
										];
									}
								}

								return {
									message: toolResultMsg,
									isError: true,
								};
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

type ToolUpdateEvent = Extract<AgentEvent, { type: "tool_execution_update" }>;

class ToolUpdateQueue {
	private updates: ToolUpdateEvent[] = [];
	private resolve?: (event: ToolUpdateEvent) => void;
	private pending?: Promise<ToolUpdateEvent>;

	push(event: ToolUpdateEvent): void {
		if (this.resolve) {
			const resolve = this.resolve;
			this.resolve = undefined;
			this.pending = undefined;
			resolve(event);
			return;
		}
		this.updates.push(event);
	}

	hasPending(): boolean {
		return this.updates.length > 0;
	}

	shift(): ToolUpdateEvent | undefined {
		return this.updates.shift();
	}

	next(): Promise<ToolUpdateEvent> {
		const queued = this.shift();
		if (queued) {
			return Promise.resolve(queued);
		}
		if (!this.pending) {
			this.pending = new Promise<ToolUpdateEvent>((resolve) => {
				this.resolve = resolve;
			});
		}
		return this.pending;
	}
}

function createToolUpdateQueue(): ToolUpdateQueue {
	return new ToolUpdateQueue();
}

async function waitForNextExecutionOrUpdate(
	pendingExecutions: PendingExecution[],
	updateQueue: ToolUpdateQueue,
): Promise<
	| { kind: "update"; event: ToolUpdateEvent }
	| {
			kind: "execution";
			execution: PendingExecution;
			outcome: ToolExecutionOutcome;
	  }
> {
	const queued = updateQueue.shift();
	if (queued) {
		return { kind: "update", event: queued };
	}

	const executionPromise = Promise.race(
		pendingExecutions.map((entry) =>
			entry.promise.then((outcome) => ({ entry, outcome })),
		),
	).then((race) => ({
		kind: "execution" as const,
		execution: race.entry,
		outcome: race.outcome,
	}));

	const updatePromise = updateQueue.next().then((event) => ({
		kind: "update" as const,
		event,
	}));

	const next = await Promise.race([executionPromise, updatePromise]);
	if (next.kind === "execution") {
		const index = pendingExecutions.indexOf(next.execution);
		if (index >= 0) {
			pendingExecutions.splice(index, 1);
		}
	}
	return next;
}
