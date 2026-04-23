/**
 * Tool Safety Pipeline
 * Pre-execution safety evaluation: rate limiting, adaptive thresholds,
 * safety middleware, firewall checks, PII policy, approval flow, and tool validation.
 *
 * Yields events as they occur and returns a verdict when complete.
 */

import {
	type ActionFirewall,
	HUMAN_EGRESS_PII_RULE_ID,
} from "../../safety/action-firewall.js";
import type { AdaptiveThresholds } from "../../safety/adaptive-thresholds.js";
import { METRICS } from "../../safety/adaptive-thresholds.js";
import type { SafetyMiddleware } from "../../safety/safety-middleware.js";
import type { WorkflowStateTracker } from "../../safety/workflow-state.js";
import {
	recordMaestroApprovalHit,
	recordMaestroFirewallBlock,
} from "../../telemetry/maestro-event-bus.js";
import { trackToolBlocked } from "../../telemetry/security-events.js";
import type { Clock } from "../../utils/clock.js";
import { createLogger } from "../../utils/logger.js";
import {
	describeToolActivity,
	describeToolDisplayName,
	summarizeToolUse,
} from "../../utils/tool-use-summary.js";
import type {
	ActionApprovalDecision,
	ActionApprovalService,
} from "../action-approval.js";
import { validateToolArguments } from "../providers/validation.js";
import type {
	AgentEvent,
	AgentRunConfig,
	AgentTool,
	Message,
	ToolCall,
	ToolResultMessage,
} from "../types.js";
import type {
	PlatformToolExecutionBridge,
	ToolExecutionBridgeInput,
	ToolExecutionBridgePlan,
} from "./tool-execution-bridge.js";
import {
	type ToolAuditLogger,
	buildPiiPolicyResult,
	extractTextFromContent,
	logToolExecutionAudit,
} from "./transport-utils.js";

const logger = createLogger("transport:tool-safety");

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ToolSafetyVerdict =
	| { outcome: "blocked"; events: AgentEvent[] }
	| {
			outcome: "proceed";
			effectiveToolCall: ToolCall;
			validatedArgs: Record<string, unknown>;
			toolDef: AgentTool;
			events: AgentEvent[];
			sanitizedExecutionArgs: Record<string, unknown>;
			toolExecutionBridgePlan?: ToolExecutionBridgePlan;
	  };

export interface ToolSafetyContext {
	toolCall: ToolCall;
	tools: AgentTool[];
	userMessage: Message;
	cfg: AgentRunConfig;
	signal?: AbortSignal;
	// Services
	clock: Clock;
	safetyMiddleware: SafetyMiddleware;
	workflowState: WorkflowStateTracker;
	adaptiveThresholds: AdaptiveThresholds;
	auditLogger?: ToolAuditLogger;
	approvalService?: ActionApprovalService;
	toolExecutionBridge?: PlatformToolExecutionBridge;
	hookService?: {
		runPreToolUseHooks: (
			toolCall: ToolCall,
			signal?: AbortSignal,
		) => Promise<{
			blocked?: boolean;
			blockReason?: string;
			updatedInput?: Record<string, unknown>;
		}>;
		runPermissionRequestHooks?: (
			toolCall: ToolCall,
			reason: string,
			signal?: AbortSignal,
		) => Promise<{
			decision?: "allow" | "deny";
			decisionReason?: string;
			updatedInput?: Record<string, unknown>;
		}>;
	};
	firewall: ActionFirewall;
	// Mutable rate-limit state
	rateLimitState: {
		recentToolTimestamps: Map<string, number[]>;
		toolCallsThisMinute: number;
		minuteWindowStart: number;
		rateWindowMs: number;
		rateLimit: number;
	};
	// Emit helpers
	emitToolResult: (
		message: ToolResultMessage,
		toolCall: ToolCall,
		isError: boolean,
		metadata?: {
			toolExecutionId?: string;
			approvalRequestId?: string;
		},
	) => AgentEvent[];
}

interface ApprovalRegistrationMetadata {
	remoteApprovalRequestId?: string;
}

interface ApprovalRegistrationAwareService {
	waitForPendingApprovalRegistration?: (
		requestId: string,
		options?: { signal?: AbortSignal },
	) => Promise<ApprovalRegistrationMetadata | null>;
}

async function waitForPendingApprovalRegistration(
	approvalService: ActionApprovalService,
	requestId: string,
	decisionPromise: Promise<ActionApprovalDecision>,
	signal?: AbortSignal,
): Promise<ApprovalRegistrationMetadata | null> {
	const registrationAware = approvalService as ActionApprovalService &
		ApprovalRegistrationAwareService;
	if (
		typeof registrationAware.waitForPendingApprovalRegistration !== "function"
	) {
		return null;
	}

	try {
		return await Promise.race([
			registrationAware.waitForPendingApprovalRegistration(requestId, {
				signal,
			}),
			decisionPromise.then(
				() => null,
				() => null,
			),
		]);
	} catch {
		return null;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate Limiting
// ─────────────────────────────────────────────────────────────────────────────

type RateLimitBlockKind = "anomaly" | "rate_limit";

interface RateLimitBlock {
	kind: RateLimitBlockKind;
	reason: string;
}

function checkRateLimit(ctx: ToolSafetyContext):
	| {
			blocked: true;
			events: AgentEvent[];
			updatedState: RateLimitUpdate;
			block: RateLimitBlock;
	  }
	| {
			blocked: false;
			recent: number[];
			updatedState: RateLimitUpdate;
	  } {
	const { toolCall, clock, adaptiveThresholds, emitToolResult } = ctx;
	const { recentToolTimestamps, rateWindowMs, rateLimit } = ctx.rateLimitState;
	let { toolCallsThisMinute, minuteWindowStart } = ctx.rateLimitState;

	const now = clock.now();
	const timestamps = recentToolTimestamps.get(toolCall.name) ?? [];
	const recent = timestamps.filter((ts) => now - ts < rateWindowMs);

	// Track tool calls per minute for adaptive thresholds
	if (now - minuteWindowStart >= 60_000) {
		adaptiveThresholds.recordObservation(
			METRICS.TOOL_CALLS_PER_MINUTE,
			toolCallsThisMinute,
		);
		toolCallsThisMinute = 0;
		minuteWindowStart = now;
	}
	toolCallsThisMinute++;

	// Track tool-specific metrics
	const toolNameLower = toolCall.name.toLowerCase();
	if (toolNameLower === "read" || toolNameLower === "glob") {
		adaptiveThresholds.recordObservation(METRICS.READS_PER_MINUTE, 1);
	} else if (toolNameLower === "write" || toolNameLower === "edit") {
		adaptiveThresholds.recordObservation(METRICS.WRITES_PER_MINUTE, 1);
	} else if (
		toolNameLower === "webfetch" ||
		toolNameLower === "websearch" ||
		toolNameLower.includes("mcp")
	) {
		adaptiveThresholds.recordObservation(METRICS.EGRESS_PER_MINUTE, 1);
	}

	const updatedState: RateLimitUpdate = {
		toolCallsThisMinute,
		minuteWindowStart,
	};

	// Check for anomalous tool call rate
	const anomalyCheck = adaptiveThresholds.checkAnomaly(
		METRICS.TOOL_CALLS_PER_MINUTE,
		toolCallsThisMinute,
	);

	// Enforce anomaly detection
	if (anomalyCheck.isAnomaly) {
		const reason = `Anomaly detected: ${anomalyCheck.reason ?? "Unusual tool call rate"}`;
		trackToolBlocked({
			toolName: toolCall.name,
			reason,
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
		return {
			blocked: true,
			events: emitToolResult(anomalyMessage, toolCall, true),
			updatedState,
			block: {
				kind: "anomaly",
				reason,
			},
		};
	}

	// Use adaptive threshold if we have enough data, otherwise use static limit
	const effectiveRateLimit = adaptiveThresholds.getAdaptedThreshold(
		`tool_rate_${toolCall.name}`,
		rateLimit,
	);

	if (recent.length >= effectiveRateLimit) {
		const reason = `Rate limit exceeded: >${effectiveRateLimit} calls in ${rateWindowMs / 1000}s window`;
		const rateMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [
				{
					type: "text",
					text: `Blocked "${toolCall.name}" due to rate limit: >${effectiveRateLimit} calls in ${rateWindowMs / 1000}s window.${
						anomalyCheck.isAnomaly
							? ` (Anomaly detected: ${anomalyCheck.reason})`
							: ""
					}`,
				},
			],
			isError: true,
			timestamp: now,
		};
		return {
			blocked: true,
			events: emitToolResult(rateMessage, toolCall, true),
			updatedState,
			block: {
				kind: "rate_limit",
				reason,
			},
		};
	}

	// Record observation for per-tool adaptive rate
	adaptiveThresholds.recordObservation(
		`tool_rate_${toolCall.name}`,
		recent.length,
	);
	recent.push(now);
	recentToolTimestamps.set(toolCall.name, recent);

	return { blocked: false, recent, updatedState };
}

interface RateLimitUpdate {
	toolCallsThisMinute: number;
	minuteWindowStart: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Safety Evaluation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluate all safety checks for a tool call before execution.
 * Yields events as they occur and returns the final verdict.
 */
export async function* evaluateToolSafety(
	ctx: ToolSafetyContext,
): AsyncGenerator<
	AgentEvent,
	{ verdict: ToolSafetyVerdict; rateLimitUpdate: RateLimitUpdate }
> {
	const {
		toolCall,
		tools,
		userMessage,
		cfg,
		signal,
		clock,
		safetyMiddleware,
		workflowState,
		auditLogger,
		approvalService,
		toolExecutionBridge,
		hookService,
		firewall,
		emitToolResult,
	} = ctx;

	const events: AgentEvent[] = [];
	const recordEvent = (event: AgentEvent) => {
		events.push(event);
		return event;
	};
	const recordEvents = (newEvents: AgentEvent[]) => {
		events.push(...newEvents);
		return newEvents;
	};

	const sanitizedStartArgs = safetyMiddleware.sanitizeForLogging(
		toolCall.arguments as Record<string, unknown>,
	);

	// 1. Rate limiting
	const rateLimitResult = checkRateLimit(ctx);
	if (rateLimitResult.blocked) {
		await logToolExecutionAudit(
			auditLogger,
			toolCall.name,
			sanitizedStartArgs,
			"denied",
			0,
			rateLimitResult.block.reason,
		);
		const blockedEvents = recordEvents(rateLimitResult.events);
		for (const event of blockedEvents) {
			yield event;
		}
		return {
			verdict: { outcome: "blocked", events },
			rateLimitUpdate: rateLimitResult.updatedState,
		};
	}
	yield recordEvent({
		type: "tool_execution_start",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		args: sanitizedStartArgs,
	});

	// 2. PreToolUse hooks
	let effectiveToolCall = toolCall;
	if (hookService) {
		const hookResult = await hookService.runPreToolUseHooks(toolCall, signal);

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
				timestamp: clock.now(),
			};
			await logToolExecutionAudit(
				auditLogger,
				toolCall.name,
				safetyMiddleware.sanitizeForLogging(
					toolCall.arguments as Record<string, unknown>,
				),
				"denied",
				0,
				hookResult.blockReason,
			);
			const hookBlockedEvents = recordEvents(
				emitToolResult(hookBlockedResult, toolCall, true),
			);
			for (const event of hookBlockedEvents) {
				yield event;
			}
			return {
				verdict: { outcome: "blocked", events },
				rateLimitUpdate: rateLimitResult.updatedState,
			};
		}

		if (hookResult.updatedInput) {
			const originalKeys = Object.keys(
				toolCall.arguments as Record<string, unknown>,
			);
			const updatedKeys = Object.keys(hookResult.updatedInput);
			const addedKeys = updatedKeys.filter((k) => !originalKeys.includes(k));
			const removedKeys = originalKeys.filter((k) => !updatedKeys.includes(k));
			const modifiedKeys = updatedKeys.filter(
				(k) =>
					originalKeys.includes(k) &&
					(toolCall.arguments as Record<string, unknown>)[k] !==
						hookResult.updatedInput![k],
			);
			logger.debug("Hook modified tool input", {
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				addedKeys,
				removedKeys,
				modifiedKeys,
			});
			effectiveToolCall = {
				...toolCall,
				arguments: hookResult.updatedInput,
			};
		}
	}

	// 3. Safety middleware sequence analysis
	const safetyCheck = safetyMiddleware.preExecution(
		effectiveToolCall.name,
		effectiveToolCall.arguments as Record<string, unknown>,
	);

	if (!safetyCheck.allowed && !safetyCheck.requiresApproval) {
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
			timestamp: clock.now(),
		};
		await logToolExecutionAudit(
			auditLogger,
			toolCall.name,
			safetyCheck.sanitizedArgs,
			"denied",
			0,
			safetyCheck.reason,
		);
		const safetyBlockedEvents = recordEvents(
			emitToolResult(safetyBlockedResult, toolCall, true),
		);
		for (const event of safetyBlockedEvents) {
			yield event;
		}
		return {
			verdict: { outcome: "blocked", events },
			rateLimitUpdate: rateLimitResult.updatedState,
		};
	}

	let approvalAllowed = true;
	let approvalReason: string | undefined;

	if (safetyCheck.requiresApproval) {
		approvalAllowed = false;
		approvalReason = safetyCheck.reason;
	}

	// 4. Firewall evaluation
	const workflowSnapshot = workflowState.snapshot();
	const toolDef = tools.find((t) => t.name === effectiveToolCall.name);
	const describeArgs = (args: Record<string, unknown>) => ({
		displayName: describeToolDisplayName(toolCall.name, args, toolDef),
		summaryLabel: summarizeToolUse(toolCall.name, args, toolDef),
		actionDescription: describeToolActivity(toolCall.name, args, toolDef),
	});
	const verdict = await firewall.evaluate({
		toolName: effectiveToolCall.name,
		args: effectiveToolCall.arguments,
		metadata: {
			workflowState: workflowSnapshot,
			annotations: toolDef?.annotations,
		},
		user: cfg.user,
		session: cfg.session,
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
						verdict.remediation ? `\n\nSuggestion: ${verdict.remediation}` : ""
					}`,
				},
			],
			isError: true,
			timestamp: clock.now(),
		};
		await logToolExecutionAudit(
			auditLogger,
			toolCall.name,
			safetyMiddleware.sanitizeForLogging(
				toolCall.arguments as Record<string, unknown>,
			),
			"denied",
			0,
			verdict.reason,
		);
		const firewallBlockedEvents = recordEvents(
			emitToolResult(blockedResult, toolCall, true),
		);
		const sanitizedFirewallArgs = safetyMiddleware.sanitizeForLogging(
			effectiveToolCall.arguments as Record<string, unknown>,
		);
		recordMaestroFirewallBlock({
			rule_id: verdict.ruleId,
			operation: toolCall.name,
			target:
				typeof sanitizedFirewallArgs.command === "string"
					? sanitizedFirewallArgs.command
					: toolCall.name,
			reason: verdict.reason,
			context: sanitizedFirewallArgs,
			correlation: {
				session_id: cfg.session?.id,
				agent_run_step_id: toolCall.id,
			},
		});
		for (const event of firewallBlockedEvents) {
			yield event;
		}
		return {
			verdict: { outcome: "blocked", events },
			rateLimitUpdate: rateLimitResult.updatedState,
		};
	}

	// 5. PII policy check
	if (
		verdict.action === "require_approval" &&
		verdict.ruleId === HUMAN_EGRESS_PII_RULE_ID
	) {
		const policyResult = buildPiiPolicyResult(
			toolCall,
			workflowSnapshot,
			clock,
		);
		const policyBlockedEvents = recordEvents(
			emitToolResult(policyResult, toolCall, true),
		);
		for (const event of policyBlockedEvents) {
			yield event;
		}
		return {
			verdict: { outcome: "blocked", events },
			rateLimitUpdate: rateLimitResult.updatedState,
		};
	}

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
			timestamp: clock.now(),
		};
		const errorEvents = recordEvents(
			emitToolResult(errorResult, toolCall, true),
		);
		for (const event of errorEvents) {
			yield event;
		}
		return {
			verdict: { outcome: "blocked", events },
			rateLimitUpdate: rateLimitResult.updatedState,
		};
	}

	let toolExecutionBridgePlan: ToolExecutionBridgePlan | undefined;
	let platformApprovalRequest:
		| import("../action-approval.js").ActionApprovalRequest
		| undefined;
	let platformApprovalResolved = false;
	const bridgeArgs = safetyMiddleware.sanitizeForLogging(
		effectiveToolCall.arguments as Record<string, unknown>,
	);
	const bridgeInput: ToolExecutionBridgeInput = {
		cfg,
		toolCall,
		toolDef,
		sanitizedArgs: bridgeArgs,
		...describeArgs(bridgeArgs),
	};
	if (toolExecutionBridge) {
		const bridgeResult = await toolExecutionBridge.prepare(bridgeInput, signal);
		switch (bridgeResult.status) {
			case "observe":
			case "allow":
				toolExecutionBridgePlan = bridgeResult.plan;
				break;
			case "wait_approval":
				toolExecutionBridgePlan = bridgeResult.plan;
				platformApprovalRequest = bridgeResult.request;
				approvalAllowed = false;
				approvalReason = bridgeResult.request.reason;
				break;
			case "deny": {
				await logToolExecutionAudit(
					auditLogger,
					effectiveToolCall.name,
					bridgeArgs,
					"denied",
					0,
					bridgeResult.reason,
				);
				const deniedResult: ToolResultMessage = {
					role: "toolResult",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					content: [{ type: "text", text: bridgeResult.reason }],
					isError: true,
					timestamp: clock.now(),
				};
				const deniedEvents = recordEvents(
					emitToolResult(deniedResult, toolCall, true, {
						toolExecutionId: bridgeResult.plan?.metadata.toolExecutionId,
						approvalRequestId: bridgeResult.plan?.metadata.approvalRequestId,
					}),
				);
				for (const event of deniedEvents) {
					yield event;
				}
				return {
					verdict: { outcome: "blocked", events },
					rateLimitUpdate: rateLimitResult.updatedState,
				};
			}
			default:
				break;
		}
	}

	// 6. Approval flow
	if (verdict.action === "require_approval" || platformApprovalRequest) {
		const localApprovalReason =
			verdict.action === "require_approval" ? verdict.reason : undefined;
		let permissionHookMadeDecision = false;
		if (hookService?.runPermissionRequestHooks) {
			const permissionHookResult = await hookService.runPermissionRequestHooks(
				effectiveToolCall,
				platformApprovalRequest?.reason ??
					localApprovalReason ??
					approvalReason ??
					"Approval required",
				signal,
			);
			if (permissionHookResult.updatedInput) {
				effectiveToolCall = {
					...effectiveToolCall,
					arguments: permissionHookResult.updatedInput,
				};
			}
			if (permissionHookResult.decision === "allow") {
				permissionHookMadeDecision = true;
				approvalAllowed = true;
				approvalReason = permissionHookResult.decisionReason;
			} else if (permissionHookResult.decision === "deny") {
				permissionHookMadeDecision = true;
				approvalAllowed = false;
				approvalReason =
					permissionHookResult.decisionReason ??
					"Permission denied by PermissionRequest hook";
			}
		}

		if (
			permissionHookMadeDecision &&
			toolExecutionBridge &&
			platformApprovalRequest &&
			toolExecutionBridgePlan?.kind === "governed"
		) {
			const resolution = await toolExecutionBridge.resolveApproval(
				bridgeInput,
				toolExecutionBridgePlan,
				{
					approved: approvalAllowed,
					reason: approvalReason,
					resolvedBy: "policy",
				},
				signal,
			);
			platformApprovalResolved = true;
			toolExecutionBridgePlan = resolution.plan;
			if (resolution.status === "deny") {
				approvalAllowed = false;
				approvalReason = resolution.reason;
			} else {
				approvalAllowed = true;
				approvalReason = undefined;
			}
		}

		if (approvalService && !permissionHookMadeDecision) {
			const sanitizedApprovalArgs = safetyMiddleware.sanitizeForLogging(
				effectiveToolCall.arguments as Record<string, unknown>,
			);
			const request =
				platformApprovalRequest ??
				({
					id: toolCall.id,
					toolName: toolCall.name,
					...describeArgs(sanitizedApprovalArgs),
					args: sanitizedApprovalArgs,
					reason: localApprovalReason ?? "Approval required",
				} satisfies import("../action-approval.js").ActionApprovalRequest);
			const shouldEmitEvents = approvalService.requiresUserInteraction();
			const decisionPromise = approvalService.requestApproval(request, signal);
			const registrationMetadata = await waitForPendingApprovalRegistration(
				approvalService,
				request.id,
				decisionPromise,
				signal,
			);
			recordMaestroApprovalHit({
				approval_request_id:
					platformApprovalRequest?.id ??
					toolExecutionBridgePlan?.metadata.approvalRequestId ??
					registrationMetadata?.remoteApprovalRequestId ??
					request.id,
				action:
					request.actionDescription ?? request.summaryLabel ?? request.toolName,
				command:
					typeof sanitizedApprovalArgs.command === "string"
						? sanitizedApprovalArgs.command
						: undefined,
				decision_mode: "MAESTRO_DECISION_MODE_REQUIRE_APPROVAL",
				reason: request.reason,
				context: {
					tool_name: request.toolName,
					display_name: request.displayName,
					summary_label: request.summaryLabel,
					args: sanitizedApprovalArgs,
				},
				correlation: {
					session_id: cfg.session?.id,
					agent_run_step_id: toolCall.id,
				},
			});
			if (shouldEmitEvents) {
				yield recordEvent({ type: "action_approval_required", request });
			}

			const decision = await decisionPromise;
			if (shouldEmitEvents) {
				yield recordEvent({
					type: "action_approval_resolved",
					request,
					decision,
				});
			}

			if (
				toolExecutionBridge &&
				platformApprovalRequest &&
				toolExecutionBridgePlan?.kind === "governed"
			) {
				const resolution = await toolExecutionBridge.resolveApproval(
					bridgeInput,
					toolExecutionBridgePlan,
					decision,
					signal,
				);
				platformApprovalResolved = true;
				toolExecutionBridgePlan = resolution.plan;
				if (resolution.status === "deny") {
					approvalAllowed = false;
					approvalReason = resolution.reason;
				} else {
					approvalAllowed = true;
					approvalReason = undefined;
				}
			}

			if (!decision.approved) {
				approvalAllowed = false;
				approvalReason = decision.reason ?? localApprovalReason;
			}
		}
	}

	if (!approvalAllowed) {
		if (
			toolExecutionBridge &&
			platformApprovalRequest &&
			toolExecutionBridgePlan?.kind === "governed" &&
			!platformApprovalResolved
		) {
			const resolution = await toolExecutionBridge.resolveApproval(
				bridgeInput,
				toolExecutionBridgePlan,
				{
					approved: false,
					reason: approvalReason ?? "Approval denied",
					resolvedBy: "policy",
				},
				signal,
			);
			toolExecutionBridgePlan = resolution.plan;
			approvalReason =
				resolution.status === "deny"
					? resolution.reason
					: (approvalReason ?? "Approval denied");
		}
		await logToolExecutionAudit(
			auditLogger,
			effectiveToolCall.name,
			safetyMiddleware.sanitizeForLogging(
				effectiveToolCall.arguments as Record<string, unknown>,
			),
			"denied",
			0,
			approvalReason,
		);
		const deniedResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: approvalReason ?? "Action denied" }],
			isError: true,
			timestamp: clock.now(),
		};
		const deniedEvents = recordEvents(
			emitToolResult(deniedResult, toolCall, true, {
				toolExecutionId: toolExecutionBridgePlan?.metadata.toolExecutionId,
				approvalRequestId: toolExecutionBridgePlan?.metadata.approvalRequestId,
			}),
		);
		for (const event of deniedEvents) {
			yield event;
		}
		return {
			verdict: { outcome: "blocked", events },
			rateLimitUpdate: rateLimitResult.updatedState,
		};
	}

	// 7. Argument validation
	let validatedArgs: Record<string, unknown>;
	try {
		const rawArgs = validateToolArguments(toolDef, effectiveToolCall);
		const vaultedArgs = safetyMiddleware.prepareExecutionArgs(rawArgs);
		validatedArgs = safetyMiddleware.resolveCredentials(vaultedArgs);
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
			timestamp: clock.now(),
		};
		const validationEvents = recordEvents(
			emitToolResult(validationErrorResult, toolCall, true),
		);
		for (const event of validationEvents) {
			yield event;
		}
		return {
			verdict: { outcome: "blocked", events },
			rateLimitUpdate: rateLimitResult.updatedState,
		};
	}

	const sanitizedExecutionArgs =
		safetyMiddleware.sanitizeForLogging(validatedArgs);

	return {
		verdict: {
			outcome: "proceed",
			effectiveToolCall,
			validatedArgs,
			toolDef,
			events,
			sanitizedExecutionArgs,
			...(toolExecutionBridgePlan ? { toolExecutionBridgePlan } : {}),
		},
		rateLimitUpdate: rateLimitResult.updatedState,
	};
}
