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

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
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
import {
	type SkillArtifactMetadata,
	getSkillArtifactMetadataFromDetails,
} from "../skills/artifact-metadata.js";
import {
	type PathScopedMutation,
	getPathScopedMutation,
	isParallelSafeTool,
	isReadOnlyTool,
	pathScopesOverlap,
} from "../tools/parallel-execution.js";
import { trackUsage } from "../tracking/cost-tracker.js";
import { getTrainingHeaders } from "../training.js";
import type { ActionApprovalService } from "./action-approval.js";
import { getStoredCredentials } from "./keys.js";
import type { ToolRetryConfig, ToolRetryService } from "./tool-retry.js";
import { createProviderStream } from "./transport/create-provider-stream.js";
import { stableStringify } from "./transport/stable-stringify.js";
import {
	type ObserveToolExecutionPlan,
	type PlatformToolExecutionBridge,
	type ToolExecutionBridgePlan,
	buildObservedResultMetadata,
	getDefaultPlatformToolExecutionBridge,
} from "./transport/tool-execution-bridge.js";
import { createToolExecutionPromise } from "./transport/tool-execution.js";
import {
	type ToolSafetyVerdict,
	evaluateToolSafety,
} from "./transport/tool-safety-pipeline.js";
import {
	type PendingExecution,
	type ToolExecutionOutcome,
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
	AgentTool,
	AgentToolResult,
	AgentTransport,
	AppMessage,
	AssistantMessage,
	Message,
	QueuedMessage,
	ToolCall,
	ToolResultMessage,
	ToolSchedulingDecision,
	ToolSchedulingMetadata,
} from "./types.js";

type GovernedToolOutcome =
	| "approval_required"
	| "approval_pending"
	| "authentication_required"
	| "denied"
	| "rate_limited";

type ReusableToolResultEntry = {
	message: ToolResultMessage;
};

type ReusableToolResultCacheGeneration = {
	value: number;
};

function hashReusableToolResultSnapshot(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function readGitSnapshotBuffer(cwd: string, args: string[]): Buffer {
	return execFileSync("git", args, {
		cwd,
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 1_000,
	});
}

function readGitSnapshotPart(cwd: string, args: string[]): string {
	return readGitSnapshotBuffer(cwd, args).toString("utf8").trim();
}

function hashGitSnapshotPart(cwd: string, args: string[]): string {
	return hashReusableToolResultSnapshot(readGitSnapshotBuffer(cwd, args));
}

function hashUntrackedGitFiles(root: string): string {
	const files = readGitSnapshotBuffer(root, [
		"ls-files",
		"--others",
		"--exclude-standard",
		"-z",
	])
		.toString("utf8")
		.split("\0")
		.filter(Boolean)
		.sort();
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(file);
		hash.update("\0");
		hash.update(readFileSync(resolvePath(root, file)));
		hash.update("\0");
	}
	return hash.digest("hex");
}

function hasDirtyGitSubmodules(root: string): boolean {
	try {
		return (
			readGitSnapshotPart(root, [
				"submodule",
				"foreach",
				"--recursive",
				"--quiet",
				"git status --porcelain=v1 --untracked-files=all",
			]).length > 0
		);
	} catch {
		return true;
	}
}

function computeReusableToolResultSnapshot(cwd: string): string | undefined {
	try {
		const root = readGitSnapshotPart(cwd, ["rev-parse", "--show-toplevel"]);
		const head = readGitSnapshotPart(cwd, ["rev-parse", "--verify", "HEAD"]);
		const status = readGitSnapshotPart(root, [
			"status",
			"--porcelain=v1",
			"--untracked-files=all",
		]);
		if (hasDirtyGitSubmodules(root)) {
			return undefined;
		}
		const unstagedDiff = hashGitSnapshotPart(root, [
			"diff",
			"--no-ext-diff",
			"--binary",
		]);
		const stagedDiff = hashGitSnapshotPart(root, [
			"diff",
			"--cached",
			"--no-ext-diff",
			"--binary",
		]);
		const untracked = hashUntrackedGitFiles(root);
		return `git:${hashReusableToolResultSnapshot(
			`${root}\n${head}\n${status}\n${unstagedDiff}\n${stagedDiff}\n${untracked}`,
		)}`;
	} catch {
		return undefined;
	}
}

const GIT_SNAPSHOT_REUSABLE_TOOL_NAMES = new Set([
	"read",
	"ls",
	"list",
	"glob",
	"find",
	"grep",
	"search",
	"parallel_ripgrep",
	"diff",
	"status",
]);

const REPO_PATH_ARGUMENTS_BY_TOOL = new Map<string, string[]>([
	["read", ["path", "file_path"]],
	["ls", ["path", "dir", "directory"]],
	["list", ["path", "dir", "directory"]],
	["glob", ["path", "cwd", "root", "glob"]],
	["find", ["path", "cwd", "root", "glob"]],
	["grep", ["path", "paths", "glob"]],
	["search", ["path", "paths", "glob"]],
	["parallel_ripgrep", ["path", "paths", "glob"]],
	["diff", ["path", "paths", "cwd"]],
	["status", ["path", "paths", "cwd"]],
]);

const REQUIRED_REPO_PATH_ARGUMENT_TOOLS = new Set(["read", "ls", "list"]);

function collectStringValues(value: unknown): string[] {
	if (typeof value === "string") {
		return [value];
	}
	if (Array.isArray(value)) {
		return value.flatMap((item) => collectStringValues(item));
	}
	return [];
}

function isRepoRelativePathArgument(value: string): boolean {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return false;
	}
	if (
		trimmed.startsWith("/") ||
		trimmed.startsWith("~") ||
		trimmed.startsWith("\\\\") ||
		/^[A-Za-z]:[\\/]/.test(trimmed)
	) {
		return false;
	}
	return !trimmed.split(/[\\/]+/).includes("..");
}

function isGitIgnoredRepoPath(cwd: string, repoPath: string): boolean {
	try {
		readGitSnapshotPart(cwd, ["check-ignore", "--quiet", "--", repoPath]);
		return true;
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"status" in error &&
			error.status === 1
		) {
			return false;
		}
		return true;
	}
}

function isStatusCallIncludingIgnored(toolCall: ToolCall): boolean {
	if (toolCall.name.toLowerCase() !== "status") {
		return false;
	}
	const args = toolCall.arguments;
	if (!args || typeof args !== "object" || Array.isArray(args)) {
		return false;
	}
	const record = args as Record<string, unknown>;
	return record.includeIgnored === true || record.include_ignored === true;
}

function hasRepoScopedReusableArguments(
	toolCall: ToolCall,
	cwd: string,
): boolean {
	const toolName = toolCall.name.toLowerCase();
	if (isStatusCallIncludingIgnored(toolCall)) {
		return false;
	}
	const argumentNames = REPO_PATH_ARGUMENTS_BY_TOOL.get(toolName) ?? [];
	if (argumentNames.length === 0) {
		return true;
	}
	const args = toolCall.arguments;
	if (!args || typeof args !== "object" || Array.isArray(args)) {
		return !REQUIRED_REPO_PATH_ARGUMENT_TOOLS.has(toolName);
	}
	const pathValues = argumentNames.flatMap((name) =>
		collectStringValues((args as Record<string, unknown>)[name]),
	);
	if (
		pathValues.length === 0 &&
		REQUIRED_REPO_PATH_ARGUMENT_TOOLS.has(toolName)
	) {
		return false;
	}
	return pathValues.every(
		(pathValue) =>
			isRepoRelativePathArgument(pathValue) &&
			!isGitIgnoredRepoPath(cwd, pathValue),
	);
}

function isGitSnapshotReusableToolCall(
	tool: AgentTool,
	toolCall: ToolCall,
	cwd: string,
): boolean {
	if (
		tool.source !== undefined ||
		tool.annotations?.openWorldHint === true ||
		tool.executionLocation === "client"
	) {
		return false;
	}
	if (!GIT_SNAPSHOT_REUSABLE_TOOL_NAMES.has(tool.name.toLowerCase())) {
		return false;
	}
	if (!isReadOnlyTool(tool.name, tool.annotations, tool.source)) {
		return false;
	}
	return hasRepoScopedReusableArguments(toolCall, cwd);
}

type ToolDefinitionLookup = ReadonlyMap<string, AgentTool> | AgentTool[];

type ToolMetadataCache = {
	readonly definitions: ReadonlyMap<string, AgentTool>;
	readonly reusableToolResultCwd: string;
	lookupCount: number;
	get(toolName: string): AgentTool | undefined;
};

const reusableToolDefinitionIdentities = new WeakMap<object, number>();
let reusableToolDefinitionIdentityCounter = 0;

function getReusableToolDefinitionIdentity(value: object): number {
	const existing = reusableToolDefinitionIdentities.get(value);
	if (existing !== undefined) {
		return existing;
	}
	reusableToolDefinitionIdentityCounter += 1;
	reusableToolDefinitionIdentities.set(
		value,
		reusableToolDefinitionIdentityCounter,
	);
	return reusableToolDefinitionIdentityCounter;
}

function getReusableToolFunctionIdentity(value: unknown): number | undefined {
	return typeof value === "function"
		? getReusableToolDefinitionIdentity(value)
		: undefined;
}

function getReusableToolRegistrySignature(tools: readonly AgentTool[]): string {
	return stableStringify(
		tools.map((tool) => ({
			allowedCallers: tool.allowedCallers,
			annotations: tool.annotations,
			deferApiDefinition: tool.deferApiDefinition,
			description: tool.description,
			executeIdentity: getReusableToolFunctionIdentity(tool.execute),
			executionLocation: tool.executionLocation,
			getActivityDescriptionIdentity: getReusableToolFunctionIdentity(
				tool.getActivityDescription,
			),
			getDisplayNameIdentity: getReusableToolFunctionIdentity(
				tool.getDisplayName,
			),
			getToolUseSummaryIdentity: getReusableToolFunctionIdentity(
				tool.getToolUseSummary,
			),
			inputExamples: tool.inputExamples,
			label: tool.label,
			maxRetries: tool.maxRetries,
			name: tool.name,
			parameters: tool.parameters,
			retryDelayMs: tool.retryDelayMs,
			shouldRetryIdentity: getReusableToolFunctionIdentity(tool.shouldRetry),
			source: tool.source,
			toolIdentity: getReusableToolDefinitionIdentity(tool),
			toolType: tool.toolType,
		})),
	);
}

function createToolMetadataCache(
	tools: AgentTool[],
	reusableToolResultCwd = process.cwd(),
): ToolMetadataCache {
	const definitions = new Map(tools.map((tool) => [tool.name, tool]));
	return {
		definitions,
		reusableToolResultCwd,
		lookupCount: 0,
		get(toolName: string): AgentTool | undefined {
			this.lookupCount += 1;
			return definitions.get(toolName);
		},
	};
}

function getToolDefinition(
	lookup: ToolDefinitionLookup | ToolMetadataCache,
	toolName: string,
): AgentTool | undefined {
	if ("get" in lookup && !Array.isArray(lookup)) {
		return lookup.get(toolName);
	}
	return lookup.find((candidate) => candidate.name === toolName);
}

function getReusableToolResultCacheKey(
	toolCall: ToolCall,
	tools: ToolDefinitionLookup | ToolMetadataCache,
): string | undefined {
	const tool = getToolDefinition(tools, toolCall.name);
	const cwd =
		"reusableToolResultCwd" in tools
			? tools.reusableToolResultCwd
			: process.cwd();
	if (!tool || !isGitSnapshotReusableToolCall(tool, toolCall, cwd)) {
		return undefined;
	}
	return `${toolCall.name}:${stableStringify(toolCall.arguments)}`;
}

function isReadOnlyToolCallForCacheInvalidation(
	toolCall: ToolCall,
	tools: ToolDefinitionLookup | ToolMetadataCache,
): boolean {
	const tool = getToolDefinition(tools, toolCall.name);
	return tool
		? isReadOnlyTool(tool.name, tool.annotations, tool.source)
		: false;
}

function cloneToolResultForCache(
	message: ToolResultMessage,
): ToolResultMessage {
	return {
		...message,
		content: message.content.map((item) => ({ ...item })),
	};
}

function cloneToolOutcomeForCall(
	outcome: ToolExecutionOutcome,
	toolCall: ToolCall,
	timestamp: number,
): ToolExecutionOutcome {
	return {
		message: {
			...outcome.message,
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: outcome.message.content.map((item) => ({ ...item })),
			timestamp,
		},
		isError: outcome.isError,
	};
}

function resolvePlatformToolExecutionBridge(
	option: PlatformToolExecutionBridge | false | undefined,
): PlatformToolExecutionBridge | undefined {
	if (option === false) {
		return undefined;
	}
	return option ?? getDefaultPlatformToolExecutionBridge();
}

async function recordReusableToolExecutionBridgeOutput({
	bridge,
	plan,
	outcome,
	durationMs,
	signal,
}: {
	bridge?: PlatformToolExecutionBridge;
	plan?: ToolExecutionBridgePlan;
	outcome: ToolExecutionOutcome;
	durationMs: number;
	signal?: AbortSignal;
}): Promise<ToolExecutionOutcome> {
	if (!bridge || !plan) {
		return outcome;
	}
	const observed =
		plan.kind === "observe"
			? await bridge.recordObservation(
					plan as ObserveToolExecutionPlan,
					outcome.message,
					signal,
				)
			: undefined;
	const governedOutput =
		plan.kind === "governed"
			? await bridge.recordGovernedOutput(
					plan,
					outcome.message,
					durationMs,
					signal,
				)
			: undefined;
	return {
		...outcome,
		...buildObservedResultMetadata(plan, observed ?? governedOutput),
	};
}

function hasReusableToolResultState(
	cacheKey: string,
	cache: Map<string, ReusableToolResultEntry>,
	pending: Map<string, Promise<ToolExecutionOutcome>>,
	policyCheckedKeys: Set<string>,
	pendingSafetyChecks: Map<string, number>,
): boolean {
	return (
		cache.has(cacheKey) ||
		pending.has(cacheKey) ||
		policyCheckedKeys.has(cacheKey) ||
		(pendingSafetyChecks.get(cacheKey) ?? 0) > 0
	);
}

function incrementPendingReusableToolSafetyCheck(
	cacheKey: string | undefined,
	pendingSafetyChecks: Map<string, number>,
): void {
	if (!cacheKey) {
		return;
	}
	pendingSafetyChecks.set(
		cacheKey,
		(pendingSafetyChecks.get(cacheKey) ?? 0) + 1,
	);
}

function decrementPendingReusableToolSafetyCheck(
	cacheKey: string | undefined,
	pendingSafetyChecks: Map<string, number>,
): void {
	if (!cacheKey) {
		return;
	}
	const nextCount = (pendingSafetyChecks.get(cacheKey) ?? 0) - 1;
	if (nextCount <= 0) {
		pendingSafetyChecks.delete(cacheKey);
		return;
	}
	pendingSafetyChecks.set(cacheKey, nextCount);
}

function clearReusableToolResultState(
	cache: Map<string, ReusableToolResultEntry>,
	pending: Map<string, Promise<ToolExecutionOutcome>>,
	policyCheckedKeys: Set<string>,
	pendingSafetyChecks: Map<string, number>,
	cacheGeneration: ReusableToolResultCacheGeneration,
): void {
	cache.clear();
	pending.clear();
	policyCheckedKeys.clear();
	pendingSafetyChecks.clear();
	cacheGeneration.value += 1;
}

function invalidateReusableToolResultsAfterMutation(
	toolCall: ToolCall,
	tools: ToolDefinitionLookup | ToolMetadataCache,
	cache: Map<string, ReusableToolResultEntry>,
	pending: Map<string, Promise<ToolExecutionOutcome>>,
	policyCheckedKeys: Set<string>,
	pendingSafetyChecks: Map<string, number>,
	cacheGeneration: ReusableToolResultCacheGeneration,
): void {
	if (isReadOnlyToolCallForCacheInvalidation(toolCall, tools)) {
		return;
	}
	clearReusableToolResultState(
		cache,
		pending,
		policyCheckedKeys,
		pendingSafetyChecks,
		cacheGeneration,
	);
}

function hasPendingMutatingToolExecution(
	pendingExecutions: readonly PendingExecution[],
	tools: ToolDefinitionLookup | ToolMetadataCache,
): boolean {
	return pendingExecutions.some(
		(execution) =>
			!isReadOnlyToolCallForCacheInvalidation(execution.toolCall, tools),
	);
}

function trackReusableToolResult(
	cacheKey: string,
	executionPromise: Promise<ToolExecutionOutcome>,
	cache: Map<string, ReusableToolResultEntry>,
	pending: Map<string, Promise<ToolExecutionOutcome>>,
	policyCheckedKeys?: Set<string>,
	cacheGeneration?: ReusableToolResultCacheGeneration,
): Promise<ToolExecutionOutcome> {
	const trackedGeneration = cacheGeneration?.value;
	const trackedPromise = executionPromise
		.then((outcome) => {
			if (
				!outcome.isError &&
				outcome.message.isError !== true &&
				(cacheGeneration === undefined ||
					cacheGeneration.value === trackedGeneration)
			) {
				cache.set(cacheKey, {
					message: cloneToolResultForCache(outcome.message),
				});
			} else {
				policyCheckedKeys?.delete(cacheKey);
			}
			return outcome;
		})
		.catch((error) => {
			policyCheckedKeys?.delete(cacheKey);
			throw error;
		})
		.finally(() => {
			if (pending.get(cacheKey) === trackedPromise) {
				pending.delete(cacheKey);
			}
		});
	pending.set(cacheKey, trackedPromise);
	return trackedPromise;
}

class AgentEventQueue {
	private events: AgentEvent[] = [];
	private pending?: Promise<void>;
	private wake?: () => void;

	push(event: AgentEvent): void {
		this.events.push(event);
		if (this.wake) {
			const wake = this.wake;
			this.pending = undefined;
			this.wake = undefined;
			wake();
		}
	}

	shift(): AgentEvent | undefined {
		return this.events.shift();
	}

	wait(): Promise<void> {
		if (this.events.length > 0) {
			return Promise.resolve();
		}
		if (!this.pending) {
			this.pending = new Promise<void>((resolve) => {
				this.wake = resolve;
			});
		}
		return this.pending;
	}

	clearPendingWaiter(): void {
		this.pending = undefined;
		this.wake = undefined;
	}
}

function isDynamicToolApprovalEvent(event: AgentEvent): boolean {
	return (
		event.type === "action_approval_required" ||
		event.type === "action_approval_resolved"
	);
}

function getGovernedToolResultEventMetadata(details: unknown): {
	errorCode?: string;
	approvalRequestId?: string;
	governedOutcome?: GovernedToolOutcome;
} {
	if (!details || typeof details !== "object") {
		return {};
	}

	const governedOutcome = (details as { governedOutcome?: unknown })
		.governedOutcome;
	if (!governedOutcome || typeof governedOutcome !== "object") {
		return {};
	}

	const normalized = governedOutcome as Record<string, unknown>;
	const classification =
		typeof normalized.classification === "string"
			? (normalized.classification as GovernedToolOutcome)
			: undefined;
	const errorCode =
		typeof normalized.code === "string" && normalized.code.trim().length > 0
			? normalized.code.trim()
			: classification;
	const approvalRequestId =
		typeof normalized.approvalRequestId === "string" &&
		normalized.approvalRequestId.trim().length > 0
			? normalized.approvalRequestId.trim()
			: undefined;

	return {
		errorCode,
		approvalRequestId,
		governedOutcome: classification,
	};
}

function getSkillToolResultEventMetadata(details: unknown): {
	skillMetadata?: SkillArtifactMetadata;
} {
	return {
		skillMetadata: getSkillArtifactMetadataFromDetails(details),
	};
}

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
	private readonly reusableToolResults = new Map<
		string,
		ReusableToolResultEntry
	>();
	private readonly pendingReusableToolResults = new Map<
		string,
		Promise<ToolExecutionOutcome>
	>();
	private readonly policyCheckedReusableToolResultKeys = new Set<string>();
	private readonly pendingReusableToolSafetyChecks = new Map<string, number>();
	private readonly reusableToolResultCacheGeneration: ReusableToolResultCacheGeneration =
		{ value: 0 };
	private reusableToolResultSnapshot?: string;
	private reusableToolRegistrySignature?: string;

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

	private refreshReusableToolResultState(
		tools: readonly AgentTool[],
		cwd: string,
	): void {
		const registrySignature = getReusableToolRegistrySignature(tools);
		const snapshot = computeReusableToolResultSnapshot(cwd);
		if (snapshot === undefined) {
			clearReusableToolResultState(
				this.reusableToolResults,
				this.pendingReusableToolResults,
				this.policyCheckedReusableToolResultKeys,
				this.pendingReusableToolSafetyChecks,
				this.reusableToolResultCacheGeneration,
			);
			this.reusableToolResultSnapshot = undefined;
			this.reusableToolRegistrySignature = registrySignature;
			return;
		}
		if (
			this.reusableToolResultSnapshot !== snapshot ||
			(this.reusableToolRegistrySignature !== undefined &&
				this.reusableToolRegistrySignature !== registrySignature)
		) {
			clearReusableToolResultState(
				this.reusableToolResults,
				this.pendingReusableToolResults,
				this.policyCheckedReusableToolResultKeys,
				this.pendingReusableToolSafetyChecks,
				this.reusableToolResultCacheGeneration,
			);
		}
		this.reusableToolResultSnapshot = snapshot;
		this.reusableToolRegistrySignature = registrySignature;
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

		const scriptedReplayRun = model.provider === "scripted-replay";
		const codexAppServerRun = model.api === "openai-codex-app-server";
		let credential: AuthCredential | undefined;
		if (
			this.options.getAuthContext &&
			!scriptedReplayRun &&
			!codexAppServerRun
		) {
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
		if (!credential && scriptedReplayRun) {
			credential = {
				provider: model.provider,
				token: "scripted-replay",
				type: "api-key",
				source: "env",
			};
		}
		if (!credential && codexAppServerRun) {
			credential = {
				provider: model.provider,
				token: "codex-app-server",
				type: "api-key",
				source: "env",
			};
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

		const dynamicToolEventQueue = new AgentEventQueue();
		const reusableToolResultCwd = this.options.cwd ?? process.cwd();
		const toolMetadataCache = createToolMetadataCache(
			tools,
			reusableToolResultCwd,
		);
		this.refreshReusableToolResultState(tools, reusableToolResultCwd);
		const reusableToolResults = this.reusableToolResults;
		const pendingReusableToolResults = this.pendingReusableToolResults;
		const policyCheckedReusableToolResultKeys =
			this.policyCheckedReusableToolResultKeys;
		const pendingReusableToolSafetyChecks =
			this.pendingReusableToolSafetyChecks;
		const reusableToolResultCacheGeneration =
			this.reusableToolResultCacheGeneration;
		const pendingDynamicToolExecutions: PendingExecution[] = [];
		const platformToolExecutionBridge = resolvePlatformToolExecutionBridge(
			this.options.platformToolExecutionBridge,
		);
		const trainingHeaders = getTrainingHeaders();
		const headers =
			trainingHeaders || model.headers || credential?.headers
				? {
						...(model.headers ?? {}),
						...(trainingHeaders ?? {}),
						...(credential?.headers ?? {}),
					}
				: undefined;

		const executeDynamicTool = async (
			toolCall: ToolCall,
		): Promise<AgentToolResult> => {
			const capturedResults: ToolExecutionOutcome[] = [];
			const dynamicToolError = (message: string): AgentToolResult => ({
				content: [{ type: "text", text: message }],
				isError: true,
			});
			const toAgentToolResult = (
				outcome: ToolExecutionOutcome | ToolResultMessage | undefined,
			): AgentToolResult => {
				if (!outcome) {
					return dynamicToolError("Dynamic tool execution was blocked");
				}
				const message = "message" in outcome ? outcome.message : outcome;
				return {
					content: message.content,
					isError: "message" in outcome ? outcome.isError : message.isError,
					details: message.details,
					...("message" in outcome && outcome.toolExecutionId
						? { toolExecutionId: outcome.toolExecutionId }
						: {}),
					...("message" in outcome && outcome.approvalRequestId
						? { approvalRequestId: outcome.approvalRequestId }
						: {}),
				};
			};
			const emitDynamicToolResult = (
				message: ToolResultMessage,
				effectiveToolCall: ToolCall,
				isError: boolean,
				metadata?: {
					toolExecutionId?: string;
					approvalRequestId?: string;
				},
			): AgentEvent[] => {
				try {
					applyWorkflowStateHooks({
						toolCall: effectiveToolCall,
						result: message,
						tracker: this.workflowState,
						isError,
					});
					capturedResults.push({
						message,
						isError,
						...metadata,
					});
				} catch (error) {
					if (error instanceof WorkflowStateError) {
						capturedResults.push({
							message: {
								role: "toolResult",
								toolCallId: effectiveToolCall.id,
								toolName: effectiveToolCall.name,
								content: [{ type: "text", text: error.message }],
								isError: true,
								timestamp: this.clock.now(),
							},
							isError: true,
							...metadata,
						});
					} else {
						throw error;
					}
				}
				return [];
			};

			try {
				const reusableToolResultKey = getReusableToolResultCacheKey(
					toolCall,
					toolMetadataCache,
				);
				const alreadyHadReusableToolResultState =
					reusableToolResultKey !== undefined &&
					hasReusableToolResultState(
						reusableToolResultKey,
						reusableToolResults,
						pendingReusableToolResults,
						policyCheckedReusableToolResultKeys,
						pendingReusableToolSafetyChecks,
					);
				incrementPendingReusableToolSafetyCheck(
					reusableToolResultKey,
					pendingReusableToolSafetyChecks,
				);
				const shouldSkipLoopDetection = (
					candidateToolCall: ToolCall,
				): boolean => {
					const candidateKey = getReusableToolResultCacheKey(
						candidateToolCall,
						toolMetadataCache,
					);
					return (
						candidateKey !== undefined &&
						candidateKey === reusableToolResultKey &&
						alreadyHadReusableToolResultState &&
						!hasPendingMutatingToolExecution(
							pendingDynamicToolExecutions,
							toolMetadataCache,
						) &&
						hasReusableToolResultState(
							candidateKey,
							reusableToolResults,
							pendingReusableToolResults,
							policyCheckedReusableToolResultKeys,
							pendingReusableToolSafetyChecks,
						)
					);
				};
				let safetyVerdict: ToolSafetyVerdict | undefined;
				let rateLimitUpdate:
					| { toolCallsThisMinute: number; minuteWindowStart: number }
					| undefined;
				try {
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
						toolExecutionBridge: platformToolExecutionBridge,
						hookService,
						firewall,
						rateLimitState: {
							recentToolTimestamps: this.recentToolTimestamps,
							toolCallsThisMinute: this.toolCallsThisMinute,
							minuteWindowStart: this.minuteWindowStart,
							rateWindowMs: ProviderTransport.TOOL_RATE_WINDOW_MS,
							rateLimit: ProviderTransport.TOOL_RATE_LIMIT,
						},
						shouldSkipLoopDetection,
						emitToolResult: emitDynamicToolResult,
					});
					while (true) {
						const safetyStep = await safetyIterator.next();
						if (safetyStep.done) {
							({ verdict: safetyVerdict, rateLimitUpdate } = safetyStep.value);
							break;
						}
						if (isDynamicToolApprovalEvent(safetyStep.value)) {
							dynamicToolEventQueue.push(safetyStep.value);
						}
					}
				} finally {
					decrementPendingReusableToolSafetyCheck(
						reusableToolResultKey,
						pendingReusableToolSafetyChecks,
					);
				}
				if (!safetyVerdict || !rateLimitUpdate) {
					return dynamicToolError("Safety pipeline did not return a verdict.");
				}
				this.toolCallsThisMinute = rateLimitUpdate.toolCallsThisMinute;
				this.minuteWindowStart = rateLimitUpdate.minuteWindowStart;
				if (safetyVerdict.outcome === "blocked") {
					return toAgentToolResult(capturedResults.at(-1));
				}

				const {
					effectiveToolCall,
					validatedArgs,
					toolDef: tool,
					sanitizedExecutionArgs,
				} = safetyVerdict;
				if (tool.executionLocation === "client") {
					return dynamicToolError(
						`Client-side tool execution is not available for Codex app-server dynamic tool "${tool.name}".`,
					);
				}
				const policyCheckedReusableToolResultKey =
					getReusableToolResultCacheKey(effectiveToolCall, toolMetadataCache);
				const canReuseToolResult =
					reusableToolResultKey !== undefined &&
					policyCheckedReusableToolResultKey === reusableToolResultKey;
				if (canReuseToolResult && reusableToolResultKey) {
					policyCheckedReusableToolResultKeys.add(reusableToolResultKey);
				}
				const canServeReusableToolResult =
					canReuseToolResult &&
					!hasPendingMutatingToolExecution(
						pendingDynamicToolExecutions,
						toolMetadataCache,
					);
				if (canServeReusableToolResult) {
					const cachedEntry = reusableToolResults.get(reusableToolResultKey);
					if (cachedEntry) {
						const cacheHitStart = this.clock.now();
						const cachedOutcome = await recordReusableToolExecutionBridgeOutput(
							{
								bridge: platformToolExecutionBridge,
								plan: safetyVerdict.toolExecutionBridgePlan,
								outcome: {
									message: {
										...cachedEntry.message,
										toolCallId: toolCall.id,
										toolName: toolCall.name,
										content: cachedEntry.message.content.map((item) => ({
											...item,
										})),
										timestamp: this.clock.now(),
									},
									isError: false,
								},
								durationMs: this.clock.now() - cacheHitStart,
								signal,
							},
						);
						emitDynamicToolResult(
							cachedOutcome.message,
							effectiveToolCall,
							cachedOutcome.isError,
							{
								toolExecutionId: cachedOutcome.toolExecutionId,
								approvalRequestId: cachedOutcome.approvalRequestId,
							},
						);
						return toAgentToolResult(capturedResults.at(-1) ?? cachedOutcome);
					}
					const pendingReusable = pendingReusableToolResults.get(
						reusableToolResultKey,
					);
					if (pendingReusable) {
						const cacheHitStart = this.clock.now();
						const cachedOutcome = await recordReusableToolExecutionBridgeOutput(
							{
								bridge: platformToolExecutionBridge,
								plan: safetyVerdict.toolExecutionBridgePlan,
								outcome: cloneToolOutcomeForCall(
									await pendingReusable,
									toolCall,
									this.clock.now(),
								),
								durationMs: this.clock.now() - cacheHitStart,
								signal,
							},
						);
						emitDynamicToolResult(
							cachedOutcome.message,
							effectiveToolCall,
							cachedOutcome.isError,
							{
								toolExecutionId: cachedOutcome.toolExecutionId,
								approvalRequestId: cachedOutcome.approvalRequestId,
							},
						);
						return toAgentToolResult(capturedResults.at(-1) ?? cachedOutcome);
					}
				}
				const toolUpdateQueue = createToolUpdateQueue();
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
					toolExecutionBridge: platformToolExecutionBridge,
					toolExecutionBridgePlan: safetyVerdict.toolExecutionBridgePlan,
					toolUpdateQueue,
				});
				const trackedExecutionPromise =
					canReuseToolResult && reusableToolResultKey
						? trackReusableToolResult(
								reusableToolResultKey,
								executionPromise,
								reusableToolResults,
								pendingReusableToolResults,
								policyCheckedReusableToolResultKeys,
								reusableToolResultCacheGeneration,
							)
						: executionPromise;
				const pendingExecution: PendingExecution = {
					toolCall: effectiveToolCall,
					promise: trackedExecutionPromise,
				};
				pendingDynamicToolExecutions.push(pendingExecution);
				const pendingExecutions: PendingExecution[] = [pendingExecution];
				let outcome: Awaited<typeof executionPromise> | undefined;
				try {
					while (pendingExecutions.length > 0) {
						const next = await waitForNextExecutionOrUpdate(
							pendingExecutions,
							toolUpdateQueue,
						);
						if (next.kind === "update") {
							if (next.event.type === "tool_retry_required") {
								this.options.toolRetryService?.skip(
									next.event.request.id,
									"Codex app-server dynamic tool callbacks cannot prompt for retry",
									"runtime",
								);
							}
							continue;
						}
						outcome = next.outcome;
					}
				} finally {
					const pendingIndex =
						pendingDynamicToolExecutions.indexOf(pendingExecution);
					if (pendingIndex >= 0) {
						pendingDynamicToolExecutions.splice(pendingIndex, 1);
					}
				}
				if (!outcome) {
					return dynamicToolError("Dynamic tool execution did not complete.");
				}
				invalidateReusableToolResultsAfterMutation(
					effectiveToolCall,
					toolMetadataCache,
					reusableToolResults,
					pendingReusableToolResults,
					policyCheckedReusableToolResultKeys,
					pendingReusableToolSafetyChecks,
					reusableToolResultCacheGeneration,
				);
				try {
					applyWorkflowStateHooks({
						toolCall: effectiveToolCall,
						result: outcome.message,
						tracker: this.workflowState,
						isError: outcome.isError,
					});
				} catch (error) {
					if (error instanceof WorkflowStateError) {
						return toAgentToolResult({
							message: {
								role: "toolResult",
								toolCallId: effectiveToolCall.id,
								toolName: effectiveToolCall.name,
								content: [{ type: "text", text: error.message }],
								isError: true,
								timestamp: this.clock.now(),
							},
							isError: true,
							toolExecutionId: outcome.toolExecutionId,
							approvalRequestId: outcome.approvalRequestId,
						});
					}
					throw error;
				}
				return toAgentToolResult(outcome);
			} finally {
				this.safetyMiddleware.clearCredentials();
			}
		};

		const streamOptions = {
			apiKey,
			maxTokens: model.maxTokens,
			signal,
			authType: credential?.type ?? "api-key",
			headers,
			requestBody: credential?.requestBody,
			sessionId: cfg.session?.id,
			cwd: this.options.cwd,
			taskBudget: cfg.taskBudget,
			executeDynamicTool,
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
			const toolResults: ToolResultMessage[] = [];
			const pendingProviderToolResultMessages: ToolResultMessage[] = [];
			let steeringAfterTools: QueuedMessage<AppMessage>[] | null = null;
			let pendingNextTurn = false;
			let encounteredError = false;
			let firstModelOutputSeen = false;

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
					toolResults.length = 0;
					pendingProviderToolResultMessages.length = 0;
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

				cfg.queryProfiler?.checkpoint("model:request:start", {
					attempt: streamAttempt,
				});
				const stream = createProviderStream(
					model,
					currentContext,
					streamOptions,
					{ reasoning: cfg.reasoning, reasoningSummary: cfg.reasoningSummary },
				);
				const streamIterator = stream[Symbol.asyncIterator]();
				let nextStreamEvent = streamIterator.next();

				try {
					while (true) {
						const queuedDynamicToolEvent = dynamicToolEventQueue.shift();
						if (queuedDynamicToolEvent) {
							yield queuedDynamicToolEvent;
							continue;
						}
						const dynamicToolEventReady = dynamicToolEventQueue.wait();
						const nextEvent = await Promise.race([
							dynamicToolEventReady.then(() => ({
								type: "dynamicTool" as const,
							})),
							nextStreamEvent.then((result) => ({
								type: "provider" as const,
								result,
							})),
						]);
						if (nextEvent.type === "dynamicTool") {
							continue;
						}
						dynamicToolEventQueue.clearPendingWaiter();
						if (nextEvent.result.done) {
							break;
						}
						const event = nextEvent.result.value;
						nextStreamEvent = streamIterator.next();
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
							if (!firstModelOutputSeen) {
								cfg.queryProfiler?.checkpoint("model:first-token");
								firstModelOutputSeen = true;
							}
							if (currentAssistantMessage) {
								yield {
									type: "message_update",
									message: currentAssistantMessage,
									assistantMessageEvent: event,
								};
							}
							continue;
						}

						if (event.type === "provider_tool_execution_start") {
							if (!firstModelOutputSeen) {
								cfg.queryProfiler?.checkpoint("model:first-token");
								firstModelOutputSeen = true;
							}
							yield {
								type: "tool_execution_start",
								toolCallId: event.toolCallId,
								toolExecutionId: event.toolExecutionId,
								toolName: event.toolName,
								displayName: event.displayName,
								summaryLabel: event.summaryLabel,
								args: event.args,
							};
							continue;
						}

						if (event.type === "provider_tool_execution_update") {
							yield {
								type: "tool_execution_update",
								toolCallId: event.toolCallId,
								toolExecutionId: event.toolExecutionId,
								toolName: event.toolName,
								displayName: event.displayName,
								summaryLabel: event.summaryLabel,
								args: event.args,
								partialResult: event.partialResult,
							};
							continue;
						}

						if (event.type === "provider_tool_execution_end") {
							toolResults.push(event.result);
							pendingProviderToolResultMessages.push(event.result);
							yield {
								type: "tool_execution_end",
								toolCallId: event.toolCallId,
								toolExecutionId: event.toolExecutionId,
								approvalRequestId: event.approvalRequestId,
								toolName: event.toolName,
								displayName: event.displayName,
								summaryLabel: event.summaryLabel,
								result: event.result,
								isError: event.isError,
							};
							continue;
						}

						if (event.type === "toolcall_end") {
							if (!firstModelOutputSeen) {
								cfg.queryProfiler?.checkpoint("model:first-token");
								firstModelOutputSeen = true;
							}
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
												sessionId: cfg.session?.id,
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
							for (const message of pendingProviderToolResultMessages) {
								yield { type: "message_start", message };
								yield { type: "message_end", message };
							}
							pendingProviderToolResultMessages.length = 0;
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
					for (
						let event = dynamicToolEventQueue.shift();
						event;
						event = dynamicToolEventQueue.shift()
					) {
						yield event;
					}
					dynamicToolEventQueue.clearPendingWaiter();
					streamSuccess = true;
				} catch (error) {
					while (dynamicToolEventQueue.shift()) {
						// Drop queued dynamic tool events from the abandoned stream attempt.
					}
					dynamicToolEventQueue.clearPendingWaiter();
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

				const toolDefinitionsByName = toolMetadataCache.definitions;
				const isReadOnlyToolCall = (toolCall: ToolCall): boolean => {
					const toolDef = toolDefinitionsByName.get(toolCall.name);
					return toolDef
						? isReadOnlyTool(toolDef.name, toolDef.annotations, toolDef.source)
						: false;
				};
				const isParallelSafeToolCall = (
					toolCall: ToolCall,
					toolDef = toolDefinitionsByName.get(toolCall.name),
				): boolean =>
					toolDef
						? isParallelSafeTool(
								toolDef.name,
								toolDef.annotations,
								toolDef.source,
							)
						: false;
				const readOnlyToolCalls = toolCallsToExecute.filter(isReadOnlyToolCall);
				const readOnlyConcurrencyLimit =
					readOnlyToolCalls.length > 0
						? Math.min(
								8,
								Math.max(configuredConcurrency, readOnlyToolCalls.length),
							)
						: configuredConcurrency;
				const parallelSafeMutationConcurrencyLimit = Math.min(
					8,
					configuredConcurrency,
				);
				const concurrencyLimitForTool = (
					defaultLimit: number,
					toolDef?: AgentTool,
				): number => {
					const sourceMaxConcurrency =
						toolDef?.source?.type === "mcp"
							? toolDef.source.parallelMaxConcurrency
							: undefined;
					return Math.min(
						defaultLimit,
						typeof sourceMaxConcurrency === "number" &&
							Number.isFinite(sourceMaxConcurrency) &&
							sourceMaxConcurrency > 0
							? Math.floor(sourceMaxConcurrency)
							: defaultLimit,
					);
				};
				const readOnlyConcurrencyLimitForTool = (toolDef?: AgentTool): number =>
					concurrencyLimitForTool(readOnlyConcurrencyLimit, toolDef);
				const parallelSafeMutationConcurrencyLimitForTool = (
					toolDef?: AgentTool,
				): number =>
					concurrencyLimitForTool(
						parallelSafeMutationConcurrencyLimit,
						toolDef,
					);
				let concurrencyLimit = configuredConcurrency;
				const pendingMutationScopes = new Map<
					PendingExecution,
					PathScopedMutation
				>();
				const pendingExecutionWaveIndexes = new Map<PendingExecution, number>();
				const pendingExecutionScheduling = new Map<
					PendingExecution,
					ToolSchedulingDecision
				>();
				const toolSchedulingDecisions = new Map<
					string,
					ToolSchedulingDecision
				>();
				const toolPhaseStartMs = this.clock.now();
				let currentWaveIndex = 0;
				const mutationPathBase = this.options.cwd ?? process.cwd();
				const toolSchedulingMetadata = new Map<
					string,
					ToolSchedulingMetadata
				>();

				const nextWaveIndex = (): number => {
					currentWaveIndex += 1;
					return currentWaveIndex;
				};

				const pendingWaveIndex = (): number =>
					pendingExecutions.length > 0
						? (pendingExecutionWaveIndexes.get(pendingExecutions[0]!) ??
							currentWaveIndex)
						: nextWaveIndex();

				const schedulerWaitMs = (): number =>
					Math.max(0, this.clock.now() - toolPhaseStartMs);

				const isMcpParallelOptIn = (toolDef: AgentTool): boolean =>
					toolDef.source?.type === "mcp" &&
					toolDef.source.supportsParallelToolCalls === true &&
					toolDef.annotations?.destructiveHint !== true;

				const buildToolPhaseSummary = ():
					| Extract<AgentEvent, { type: "tool_phase_summary" }>
					| undefined => {
					const rawDecisions = [...toolSchedulingDecisions.values()].sort(
						(left, right) => left.emittedIndex - right.emittedIndex,
					);
					if (rawDecisions.length === 0) {
						return undefined;
					}
					const waveCounts = new Map<number, number>();
					for (const decision of rawDecisions) {
						if (decision.waveIndex !== undefined) {
							waveCounts.set(
								decision.waveIndex,
								(waveCounts.get(decision.waveIndex) ?? 0) + 1,
							);
						}
					}
					const decisions: Extract<
						AgentEvent,
						{ type: "tool_phase_summary" }
					>["decisions"] = rawDecisions.map((decision) => {
						const isSingleModelToolCall = rawDecisions.length === 1;
						const waveSize =
							decision.waveIndex !== undefined
								? (waveCounts.get(decision.waveIndex) ?? 1)
								: 1;
						const outcome =
							decision.cacheHit === true
								? "cached"
								: decision.decision === "skipped"
									? "skipped"
									: decision.decision === "delayed" ||
											decision.blockedByMutation === true
										? "delayed"
										: decision.decision === "parallelized" ||
												(waveSize > 1 && decision.decision === "scheduled")
											? "parallelized"
											: "serialized";
						const reason =
							outcome === "cached"
								? "cache_hit"
								: decision.blockedByMutation === true
									? decision.reason
									: decision.reason === "workflow_state_serialized"
										? "workflow_state_serialized"
										: decision.mcpOptIn === true
											? "mcp_parallel_opt_in"
											: decision.reason.startsWith("read_only")
												? outcome === "parallelized"
													? "read_only_parallel_safe"
													: isSingleModelToolCall
														? "single_read_only_call"
														: decision.reason
												: decision.reason.startsWith("path_scoped_mutation")
													? "path_scoped_mutation"
													: decision.reason;
						return {
							toolCallId: decision.callId,
							toolName: decision.toolName,
							emittedIndex: decision.emittedIndex,
							outcome,
							decision: outcome,
							reason,
							waveIndex:
								decision.waveIndex !== undefined
									? Math.max(0, decision.waveIndex - 1)
									: undefined,
							waitMs: Math.max(0, Math.round(decision.schedulerWaitMs ?? 0)),
							schedulerWaitMs: Math.max(
								0,
								Math.round(decision.schedulerWaitMs ?? 0),
							),
							mcpOptIn: decision.mcpOptIn,
							cacheHit: decision.cacheHit,
							blockedByMutation: decision.blockedByMutation,
						};
					});
					const parallelizedCallCount = decisions.filter(
						(decision) => decision.outcome === "parallelized",
					).length;
					const delayedCallCount = decisions.filter(
						(decision) => decision.outcome === "delayed",
					).length;
					const batchShapingFeedback =
						decisions.length === 1 &&
						decisions[0]?.reason === "single_read_only_call"
							? {
									avoidableSingleton: true,
									reason: "single_read_only_call",
									hint: "When you need several independent reads or searches, emit them together in one assistant message so Maestro can batch them safely.",
								}
							: undefined;
					const serializationReasons = Object.fromEntries(
						[...decisions]
							.filter(
								(decision) =>
									decision.outcome === "serialized" ||
									decision.outcome === "delayed",
							)
							.reduce((counts, decision) => {
								counts.set(
									decision.reason,
									(counts.get(decision.reason) ?? 0) + 1,
								);
								return counts;
							}, new Map<string, number>()),
					);

					return {
						type: "tool_phase_summary",
						modelToolCallCount: rawDecisions.length,
						modelEmittedToolCallCount: rawDecisions.length,
						schedulableWaveCount: waveCounts.size,
						parallelizedCallCount,
						actuallyParallelizedCallCount: parallelizedCallCount,
						serializedCallCount: decisions.filter(
							(decision) =>
								decision.outcome === "serialized" ||
								decision.outcome === "delayed",
						).length,
						delayedCallCount,
						blockedByMutationCount: decisions.filter(
							(decision) => decision.blockedByMutation === true,
						).length,
						mcpOptInCallCount: decisions.filter(
							(decision) => decision.mcpOptIn === true,
						).length,
						mcpOptInUseCount: decisions.filter(
							(decision) => decision.mcpOptIn === true,
						).length,
						cacheHitCount: decisions.filter(
							(decision) => decision.cacheHit === true,
						).length,
						totalToolWaitMs: decisions.reduce(
							(total, decision) => total + decision.waitMs,
							0,
						),
						toolWaitTimeMs: decisions.reduce(
							(total, decision) => total + decision.waitMs,
							0,
						),
						serializationReasons,
						decisions,
						batchShapingFeedback,
					};
				};

				const getMutationScope = (
					toolCall: ToolCall,
					toolDef = toolMetadataCache.get(toolCall.name),
				): PathScopedMutation | undefined =>
					getPathScopedMutation(toolCall, toolDef, mutationPathBase);

				const sameMutationScope = (
					left: PathScopedMutation | undefined,
					right: PathScopedMutation | undefined,
				): boolean => {
					if (!left || !right) {
						return left === right;
					}
					const leftArgumentKeys = left.argumentKeys ?? [];
					const rightArgumentKeys = right.argumentKeys ?? [];
					return (
						left.source === right.source &&
						left.paths.length === right.paths.length &&
						left.paths.every((path, index) => path === right.paths[index]) &&
						leftArgumentKeys.length === rightArgumentKeys.length &&
						leftArgumentKeys.every(
							(argumentKey, index) => argumentKey === rightArgumentKeys[index],
						)
					);
				};

				const pendingMutationCount = (): number =>
					pendingExecutions.filter((execution) => {
						const toolDef = toolMetadataCache.definitions.get(
							execution.toolCall.name,
						);
						return (
							!!toolDef &&
							!isReadOnlyTool(toolDef.name, toolDef.annotations, toolDef.source)
						);
					}).length;

				const mergeToolSchedulingMetadata = (
					toolCallId: string,
					metadata: ToolSchedulingMetadata,
				): ToolSchedulingMetadata => {
					toolSchedulingMetadata.set(toolCallId, metadata);
					return metadata;
				};

				const pathScopeSchedulingReason = (
					scope: PathScopedMutation,
					canJoinPathScope: boolean,
				): ToolSchedulingMetadata["reason"] => {
					if (pendingExecutions.length === 0 || pendingMutationCount() === 0) {
						return "path_scope_available";
					}
					if (canJoinPathScope) {
						return "path_scope_disjoint";
					}
					const hasPathOverlap = pendingExecutions.some((execution) => {
						const pendingScope = pendingMutationScopes.get(execution);
						return pendingScope
							? pathScopesOverlap(scope, pendingScope)
							: false;
					});
					return hasPathOverlap ? "path_scope_overlap" : "pending_mutation";
				};

				const buildToolSchedulingMetadata = ({
					toolDef,
					readOnly,
					parallelSafe,
					scope,
					cache,
					canJoinPathScope,
					laneConcurrencyLimit = concurrencyLimit,
				}: {
					toolDef?: AgentTool;
					readOnly: boolean;
					parallelSafe: boolean;
					scope?: PathScopedMutation;
					cache: ToolSchedulingMetadata["cache"];
					canJoinPathScope: boolean;
					laneConcurrencyLimit?: number;
				}): ToolSchedulingMetadata => {
					const pendingMutations = pendingMutationCount();
					const base: ToolSchedulingMetadata = {
						classification: "unknown",
						reason: "unknown_tool",
						concurrencyLimit: laneConcurrencyLimit,
						queueDepth: pendingExecutions.length,
						pendingMutations,
						cache,
					};
					if (!toolDef) {
						return base;
					}
					if (requiresSerializedTurn) {
						return {
							...base,
							classification: "workflow_serialized",
							reason: "workflow_state_tracker",
						};
					}
					if (readOnly) {
						return {
							...base,
							classification: "read_only",
							reason: "read_only_tool",
						};
					}
					if (scope) {
						return {
							...base,
							classification: "path_scoped_mutation",
							reason: pathScopeSchedulingReason(scope, canJoinPathScope),
							pathScope: scope.paths,
							pathScopeSource: scope.source,
							pathArgumentKeys: scope.argumentKeys,
						};
					}
					if (parallelSafe && !readOnly) {
						return {
							...base,
							classification: "parallel_safe_mutation",
							reason: "mcp_parallel_opt_in",
						};
					}
					if (pendingMutations > 0) {
						return {
							...base,
							classification: "serialized_mutation",
							reason: "pending_mutation",
						};
					}
					return {
						...base,
						classification: "serialized_mutation",
						reason: "mutating_tool",
					};
				};

				const hasPendingUnscopedMutation = (): boolean =>
					pendingExecutions.some((execution) => {
						const toolDef = toolMetadataCache.get(execution.toolCall.name);
						return (
							!!toolDef &&
							!isReadOnlyTool(
								toolDef.name,
								toolDef.annotations,
								toolDef.source,
							) &&
							!pendingMutationScopes.has(execution)
						);
					});

				const mutationBlockReason = (
					scope: PathScopedMutation | undefined,
				): string =>
					scope && !hasPendingUnscopedMutation()
						? "mutation_scope_overlap"
						: "mutation_unknown_write_set";

				const isPendingParallelSafeMutation = (
					execution: PendingExecution,
				): boolean => {
					const toolDef = toolMetadataCache.get(execution.toolCall.name);
					return (
						!!toolDef &&
						!isReadOnlyTool(
							toolDef.name,
							toolDef.annotations,
							toolDef.source,
						) &&
						isParallelSafeTool(
							toolDef.name,
							toolDef.annotations,
							toolDef.source,
						) &&
						!pendingMutationScopes.has(execution)
					);
				};

				const canJoinParallelSafeMutationWave = (
					toolCall: ToolCall,
					toolDef = toolMetadataCache.get(toolCall.name),
				): boolean =>
					!!toolDef &&
					!isReadOnlyTool(toolDef.name, toolDef.annotations, toolDef.source) &&
					isParallelSafeTool(
						toolDef.name,
						toolDef.annotations,
						toolDef.source,
					) &&
					pendingExecutions.length > 0 &&
					pendingExecutions.every(isPendingParallelSafeMutation);

				const canJoinPathScopedMutationIsland = (
					scope: PathScopedMutation | undefined,
				): scope is PathScopedMutation =>
					!!scope &&
					pendingExecutions.length > 0 &&
					pendingExecutions.every((execution) => {
						const pendingScope = pendingMutationScopes.get(execution);
						return pendingScope
							? !pathScopesOverlap(scope, pendingScope)
							: false;
					});
				const laneConcurrencyLimit = ({
					readOnly,
					scope,
					parallelSafe,
					toolDef,
				}: {
					readOnly: boolean;
					scope?: PathScopedMutation;
					parallelSafe: boolean;
					toolDef?: AgentTool;
				}): number =>
					requiresSerializedTurn
						? 1
						: readOnly
							? readOnlyConcurrencyLimitForTool(toolDef)
							: scope
								? configuredConcurrency
								: parallelSafe
									? parallelSafeMutationConcurrencyLimitForTool(toolDef)
									: 1;

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
				let mutatingToolCompletedInCurrentBatch = false;

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
				): AgentEvent[] => {
					const governedMetadata = getGovernedToolResultEventMetadata(
						message.details,
					);
					const skillMetadata = getSkillToolResultEventMetadata(
						message.details,
					).skillMetadata;
					return [
						{ type: "message_start", message } as AgentEvent,
						{ type: "message_end", message } as AgentEvent,
						{
							type: "tool_execution_end",
							toolCallId: toolCall.id,
							toolExecutionId: metadata?.toolExecutionId,
							approvalRequestId:
								metadata?.approvalRequestId ??
								governedMetadata.approvalRequestId,
							errorCode: governedMetadata.errorCode,
							governedOutcome: governedMetadata.governedOutcome,
							skillMetadata,
							toolName: toolCall.name,
							result: message,
							isError,
							scheduling: toolSchedulingMetadata.get(toolCall.id),
						} as AgentEvent,
					];
				};
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
				const emittedIndexForToolCall = (toolCall: ToolCall): number => {
					const emittedIndex = toolCallsToExecute.findIndex(
						(candidate) => candidate.id === toolCall.id,
					);
					return emittedIndex >= 0
						? emittedIndex
						: toolSchedulingDecisions.size;
				};
				const emitSkippedToolCall = (toolCall: ToolCall): AgentEvent[] => {
					const sanitizedSkippedArgs = this.safetyMiddleware.sanitizeForLogging(
						toolCall.arguments as Record<string, unknown>,
					);
					const existingScheduling = toolSchedulingMetadata.get(toolCall.id);
					const toolDef = toolMetadataCache.get(toolCall.name);
					const skippedToolCallReadOnly = isReadOnlyToolCall(toolCall);
					const skippedToolCallParallelSafe = isParallelSafeToolCall(
						toolCall,
						toolDef,
					);
					const mutationScope = getMutationScope(toolCall, toolDef);
					const reusableToolResultKey = getReusableToolResultCacheKey(
						toolCall,
						toolMetadataCache,
					);
					const schedulingMetadata = mergeToolSchedulingMetadata(
						toolCall.id,
						existingScheduling ??
							buildToolSchedulingMetadata({
								toolDef,
								readOnly: skippedToolCallReadOnly,
								parallelSafe: skippedToolCallParallelSafe,
								scope: mutationScope,
								cache:
									reusableToolResultKey === undefined ? "disabled" : "miss",
								canJoinPathScope:
									canJoinPathScopedMutationIsland(mutationScope),
								laneConcurrencyLimit: laneConcurrencyLimit({
									readOnly: skippedToolCallReadOnly,
									parallelSafe: skippedToolCallParallelSafe,
									scope: mutationScope,
									toolDef,
								}),
							}),
					);
					const schedulingDecision: ToolSchedulingDecision = {
						callId: toolCall.id,
						toolName: toolCall.name,
						emittedIndex: emittedIndexForToolCall(toolCall),
						decision: "skipped",
						reason: "steering_interrupted",
						schedulerWaitMs: schedulerWaitMs(),
					};
					toolSchedulingDecisions.set(toolCall.id, schedulingDecision);
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
							scheduling: schedulingMetadata,
						} as AgentEvent,
						...emitToolResult(skippedResult, toolCall, true),
					];
				};
				const recordSafetyBlockedToolCall = (
					toolCall: ToolCall,
				): ToolSchedulingDecision => {
					const existing = toolSchedulingDecisions.get(toolCall.id);
					if (existing) {
						return existing;
					}
					const scheduling: ToolSchedulingDecision = {
						callId: toolCall.id,
						toolName: toolCall.name,
						emittedIndex: emittedIndexForToolCall(toolCall),
						decision: "skipped",
						reason: "safety_blocked",
						schedulerWaitMs: schedulerWaitMs(),
					};
					toolSchedulingDecisions.set(toolCall.id, scheduling);
					return scheduling;
				};
				const emitSafetyPipelineToolResult = (
					message: ToolResultMessage,
					toolCall: ToolCall,
					isError: boolean,
					metadata?: {
						toolExecutionId?: string;
						approvalRequestId?: string;
					},
				): AgentEvent[] => {
					if (isError) {
						recordSafetyBlockedToolCall(toolCall);
					}
					return emitToolResult(message, toolCall, isError, metadata);
				};
				const resolveNextPendingExecution = async (): Promise<AgentEvent[]> => {
					const events: AgentEvent[] = [];
					while (true) {
						const next = await waitForNextExecutionOrUpdate(
							pendingExecutions,
							toolUpdateQueue,
						);
						if (next.kind === "update") {
							events.push(next.event);
							continue;
						}
						const outcome = next.outcome;
						pendingMutationScopes.delete(next.execution);
						pendingExecutionWaveIndexes.delete(next.execution);
						pendingExecutionScheduling.delete(next.execution);
						const completedToolWasMutating =
							getReusableToolResultCacheKey(
								next.execution.toolCall,
								toolMetadataCache,
							) === undefined;
						invalidateReusableToolResultsAfterMutation(
							next.execution.toolCall,
							toolMetadataCache,
							reusableToolResults,
							pendingReusableToolResults,
							policyCheckedReusableToolResultKeys,
							pendingReusableToolSafetyChecks,
							reusableToolResultCacheGeneration,
						);
						mutatingToolCompletedInCurrentBatch ||= completedToolWasMutating;
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
						return events;
					}
				};
				const drainPendingExecutions = async (
					targetPendingCount = 0,
				): Promise<AgentEvent[]> => {
					const events: AgentEvent[] = [];
					while (pendingExecutions.length > targetPendingCount) {
						events.push(...(await resolveNextPendingExecution()));
					}
					return events;
				};
				const scheduleResolveIfNeeded = async (): Promise<AgentEvent[]> => {
					if (pendingExecutions.length < concurrencyLimit) {
						return [];
					}
					return drainPendingExecutions(concurrencyLimit - 1);
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
					let schedulingDelayReason: string | undefined;
					let blockedByMutation = false;
					const noteMutationDelay = (reason: string): void => {
						schedulingDelayReason ??= reason;
						blockedByMutation = true;
					};
					const originalToolCallReadOnly = isReadOnlyToolCall(toolCall);
					const originalMutationScope = originalToolCallReadOnly
						? undefined
						: getMutationScope(toolCall);
					const originalToolDef = toolDefinitionsByName.get(toolCall.name);
					const originalToolCallParallelSafe = isParallelSafeToolCall(
						toolCall,
						originalToolDef,
					);
					const originalCanJoinPathScope = canJoinPathScopedMutationIsland(
						originalMutationScope,
					);
					const originalJoinsParallelSafeMutationWave =
						!originalToolCallReadOnly &&
						canJoinParallelSafeMutationWave(toolCall);
					let preDrainSchedulingMetadata: ToolSchedulingMetadata | undefined;
					if (
						!originalToolCallReadOnly &&
						pendingExecutions.length > 0 &&
						pendingMutationCount() > 0 &&
						!originalCanJoinPathScope &&
						!originalJoinsParallelSafeMutationWave
					) {
						preDrainSchedulingMetadata = buildToolSchedulingMetadata({
							toolDef: originalToolDef,
							readOnly: originalToolCallReadOnly,
							parallelSafe: originalToolCallParallelSafe,
							scope: originalMutationScope,
							cache: "disabled",
							canJoinPathScope: originalCanJoinPathScope,
							laneConcurrencyLimit: laneConcurrencyLimit({
								readOnly: originalToolCallReadOnly,
								parallelSafe: originalToolCallParallelSafe,
								scope: originalMutationScope,
								toolDef: originalToolDef,
							}),
						});
						if (
							hasPendingMutatingToolExecution(
								pendingExecutions,
								toolMetadataCache,
							)
						) {
							noteMutationDelay(mutationBlockReason(originalMutationScope));
						}
						const events = await drainPendingExecutions();
						for (const event of events) {
							yield event;
						}
						if (steeringTriggered) {
							if (preDrainSchedulingMetadata) {
								mergeToolSchedulingMetadata(
									toolCall.id,
									preDrainSchedulingMetadata,
								);
							}
							remainingToolCalls = toolCallsToExecute.slice(toolIndex);
							break;
						}
					}
					const reusableToolResultKey = getReusableToolResultCacheKey(
						toolCall,
						toolMetadataCache,
					);
					const alreadyHadReusableToolResultState =
						reusableToolResultKey !== undefined &&
						hasReusableToolResultState(
							reusableToolResultKey,
							reusableToolResults,
							pendingReusableToolResults,
							policyCheckedReusableToolResultKeys,
							pendingReusableToolSafetyChecks,
						);
					incrementPendingReusableToolSafetyCheck(
						reusableToolResultKey,
						pendingReusableToolSafetyChecks,
					);
					const shouldSkipLoopDetection = (
						candidateToolCall: ToolCall,
					): boolean => {
						const candidateKey = getReusableToolResultCacheKey(
							candidateToolCall,
							toolMetadataCache,
						);
						return (
							candidateKey !== undefined &&
							candidateKey === reusableToolResultKey &&
							alreadyHadReusableToolResultState &&
							!hasPendingMutatingToolExecution(
								pendingExecutions,
								toolMetadataCache,
							) &&
							!mutatingToolCompletedInCurrentBatch &&
							hasReusableToolResultState(
								candidateKey,
								reusableToolResults,
								pendingReusableToolResults,
								policyCheckedReusableToolResultKeys,
								pendingReusableToolSafetyChecks,
							)
						);
					};
					const nextInitialSchedulingMetadata = buildToolSchedulingMetadata({
						toolDef: originalToolDef,
						readOnly: originalToolCallReadOnly,
						parallelSafe: originalToolCallParallelSafe,
						scope: originalMutationScope,
						cache:
							reusableToolResultKey === undefined
								? "disabled"
								: alreadyHadReusableToolResultState
									? "candidate"
									: "miss",
						canJoinPathScope: canJoinPathScopedMutationIsland(
							originalMutationScope,
						),
						laneConcurrencyLimit: laneConcurrencyLimit({
							readOnly: originalToolCallReadOnly,
							parallelSafe: originalToolCallParallelSafe,
							scope: originalMutationScope,
							toolDef: originalToolDef,
						}),
					});
					const initialSchedulingMetadata = mergeToolSchedulingMetadata(
						toolCall.id,
						preDrainSchedulingMetadata
							? {
									...nextInitialSchedulingMetadata,
									classification: preDrainSchedulingMetadata.classification,
									reason: preDrainSchedulingMetadata.reason,
									queueDepth: preDrainSchedulingMetadata.queueDepth,
									pendingMutations: preDrainSchedulingMetadata.pendingMutations,
								}
							: nextInitialSchedulingMetadata,
					);

					// Run safety pipeline (rate limiting, hooks, firewall, approval, validation)
					let safetyVerdict: ToolSafetyVerdict | undefined;
					let rateLimitUpdate:
						| { toolCallsThisMinute: number; minuteWindowStart: number }
						| undefined;
					try {
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
							toolExecutionBridge: platformToolExecutionBridge,
							hookService,
							firewall,
							rateLimitState: {
								recentToolTimestamps: this.recentToolTimestamps,
								toolCallsThisMinute: this.toolCallsThisMinute,
								minuteWindowStart: this.minuteWindowStart,
								rateWindowMs: ProviderTransport.TOOL_RATE_WINDOW_MS,
								rateLimit: ProviderTransport.TOOL_RATE_LIMIT,
							},
							shouldSkipLoopDetection,
							schedulingMetadata: initialSchedulingMetadata,
							emitToolResult: emitSafetyPipelineToolResult,
						});
						while (true) {
							const safetyStep = await safetyIterator.next();
							if (safetyStep.done) {
								({ verdict: safetyVerdict, rateLimitUpdate } =
									safetyStep.value);
								break;
							}
							yield safetyStep.value;
						}
					} finally {
						decrementPendingReusableToolSafetyCheck(
							reusableToolResultKey,
							pendingReusableToolSafetyChecks,
						);
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
					const effectiveToolCallReadOnly =
						isReadOnlyTool(tool.name, tool.annotations, tool.source) &&
						tool.annotations?.destructiveHint !== true;
					const effectiveToolCallParallelSafe = isParallelSafeTool(
						tool.name,
						tool.annotations,
						tool.source,
					);
					if (
						effectiveToolCallReadOnly &&
						hasPendingMutatingToolExecution(
							pendingExecutions,
							toolMetadataCache,
						)
					) {
						noteMutationDelay("pending_mutation");
						const events = await drainPendingExecutions();
						for (const event of events) {
							yield event;
						}
						if (steeringTriggered) {
							remainingToolCalls = toolCallsToExecute.slice(toolIndex);
							break;
						}
					}
					const effectiveMutationScope = effectiveToolCallReadOnly
						? undefined
						: getMutationScope(effectiveToolCall, tool);
					const joinsPathScopedMutationIsland =
						!requiresSerializedTurn &&
						canJoinPathScopedMutationIsland(effectiveMutationScope);
					const joinsParallelSafeMutationWave =
						!requiresSerializedTurn &&
						!effectiveToolCallReadOnly &&
						canJoinParallelSafeMutationWave(effectiveToolCall, tool);
					if (
						!effectiveToolCallReadOnly &&
						pendingExecutions.length > 0 &&
						!joinsPathScopedMutationIsland &&
						!joinsParallelSafeMutationWave
					) {
						if (
							hasPendingMutatingToolExecution(
								pendingExecutions,
								toolMetadataCache,
							)
						) {
							noteMutationDelay(mutationBlockReason(effectiveMutationScope));
						}
						const events = await drainPendingExecutions();
						for (const event of events) {
							yield event;
						}
						if (steeringTriggered) {
							remainingToolCalls = toolCallsToExecute.slice(toolIndex);
							break;
						}
					}
					concurrencyLimit = requiresSerializedTurn
						? 1
						: effectiveToolCallReadOnly
							? readOnlyConcurrencyLimitForTool(tool)
							: effectiveMutationScope
								? configuredConcurrency
								: effectiveToolCallParallelSafe
									? parallelSafeMutationConcurrencyLimitForTool(tool)
									: 1;
					const effectiveSchedulingMetadata = buildToolSchedulingMetadata({
						toolDef: tool,
						readOnly: effectiveToolCallReadOnly,
						parallelSafe: effectiveToolCallParallelSafe,
						scope: effectiveMutationScope,
						cache:
							reusableToolResultKey === undefined
								? "disabled"
								: alreadyHadReusableToolResultState
									? "candidate"
									: "miss",
						canJoinPathScope: joinsPathScopedMutationIsland,
						laneConcurrencyLimit: laneConcurrencyLimit({
							readOnly: effectiveToolCallReadOnly,
							parallelSafe: effectiveToolCallParallelSafe,
							scope: effectiveMutationScope,
							toolDef: tool,
						}),
					});
					const previousSchedulingMetadata = toolSchedulingMetadata.get(
						toolCall.id,
					);
					const preservePreHookBlockedSchedulingReason =
						(previousSchedulingMetadata?.reason === "path_scope_overlap" ||
							previousSchedulingMetadata?.reason === "pending_mutation") &&
						sameMutationScope(originalMutationScope, effectiveMutationScope);
					mergeToolSchedulingMetadata(
						toolCall.id,
						preservePreHookBlockedSchedulingReason
							? {
									...effectiveSchedulingMetadata,
									classification: previousSchedulingMetadata.classification,
									reason: previousSchedulingMetadata.reason,
									queueDepth: previousSchedulingMetadata.queueDepth,
									pendingMutations: previousSchedulingMetadata.pendingMutations,
								}
							: effectiveSchedulingMetadata,
					);
					// Use hook-modified (pre-validation) args for hook inputs
					const policyCheckedReusableToolResultKey =
						getReusableToolResultCacheKey(effectiveToolCall, toolMetadataCache);
					const canReuseToolResult =
						reusableToolResultKey !== undefined &&
						policyCheckedReusableToolResultKey === reusableToolResultKey;
					if (canReuseToolResult && reusableToolResultKey) {
						policyCheckedReusableToolResultKeys.add(reusableToolResultKey);
					}
					const canServeReusableToolResult =
						canReuseToolResult &&
						!hasPendingMutatingToolExecution(
							pendingExecutions,
							toolMetadataCache,
						) &&
						!mutatingToolCompletedInCurrentBatch;
					if (canServeReusableToolResult) {
						const cachedEntry = reusableToolResults.get(reusableToolResultKey);
						if (cachedEntry) {
							const scheduling: ToolSchedulingDecision = {
								callId: toolCall.id,
								toolName: toolCall.name,
								emittedIndex: toolIndex,
								decision: "cached",
								reason: "reusable_tool_result_ready",
								schedulerWaitMs: schedulerWaitMs(),
								cacheHit: true,
							};
							toolSchedulingDecisions.set(toolCall.id, scheduling);
							const cacheHitStart = this.clock.now();
							const cachedOutcome =
								await recordReusableToolExecutionBridgeOutput({
									bridge: platformToolExecutionBridge,
									plan: safetyVerdict.toolExecutionBridgePlan,
									outcome: {
										message: {
											...cachedEntry.message,
											toolCallId: toolCall.id,
											toolName: toolCall.name,
											content: cachedEntry.message.content.map((item) => ({
												...item,
											})),
											timestamp: this.clock.now(),
										},
										isError: false,
									},
									durationMs: this.clock.now() - cacheHitStart,
									signal,
								});
							mergeToolSchedulingMetadata(toolCall.id, {
								classification: "cache_reuse",
								reason: "cache_hit",
								concurrencyLimit,
								queueDepth: pendingExecutions.length,
								pendingMutations: pendingMutationCount(),
								cache: "hit",
							});
							for (const event of emitToolResult(
								cachedOutcome.message,
								toolCall,
								cachedOutcome.isError,
								{
									toolExecutionId: cachedOutcome.toolExecutionId,
									approvalRequestId: cachedOutcome.approvalRequestId,
								},
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
						const pendingReusable = pendingReusableToolResults.get(
							reusableToolResultKey,
						);
						if (pendingReusable) {
							mergeToolSchedulingMetadata(toolCall.id, {
								classification: "cache_reuse",
								reason: "cache_pending",
								concurrencyLimit,
								queueDepth: pendingExecutions.length,
								pendingMutations: pendingMutationCount(),
								cache: "pending_hit",
							});
							const waveIndex = pendingWaveIndex();
							const scheduling: ToolSchedulingDecision = {
								callId: toolCall.id,
								toolName: toolCall.name,
								emittedIndex: toolIndex,
								waveIndex,
								decision: "cached",
								reason: "reusable_tool_result_pending",
								schedulerWaitMs: schedulerWaitMs(),
								cacheHit: true,
							};
							toolSchedulingDecisions.set(toolCall.id, scheduling);
							const pendingExecution: PendingExecution = {
								toolCall,
								promise: (async () => {
									const cacheHitStart = this.clock.now();
									return recordReusableToolExecutionBridgeOutput({
										bridge: platformToolExecutionBridge,
										plan: safetyVerdict.toolExecutionBridgePlan,
										outcome: cloneToolOutcomeForCall(
											await pendingReusable,
											toolCall,
											this.clock.now(),
										),
										durationMs: this.clock.now() - cacheHitStart,
										signal,
									});
								})(),
							};
							pendingExecutions.push(pendingExecution);
							pendingExecutionWaveIndexes.set(pendingExecution, waveIndex);
							pendingExecutionScheduling.set(pendingExecution, scheduling);
							const events = await scheduleResolveIfNeeded();
							for (const event of events) {
								yield event;
							}
							if (steeringTriggered) {
								remainingToolCalls = toolCallsToExecute.slice(toolIndex + 1);
								break;
							}
							continue;
						}
					}

					const pendingBeforeSchedule = pendingExecutions.length;
					const waveIndex =
						pendingBeforeSchedule > 0 ? pendingWaveIndex() : nextWaveIndex();
					const mcpOptIn =
						isMcpParallelOptIn(tool) && !effectiveToolCallReadOnly;
					const decision =
						schedulingDelayReason !== undefined
							? "delayed"
							: pendingBeforeSchedule > 0
								? "parallelized"
								: requiresSerializedTurn ||
										(!effectiveToolCallReadOnly &&
											!effectiveMutationScope &&
											!effectiveToolCallParallelSafe)
									? "serialized"
									: "scheduled";
					const reason =
						schedulingDelayReason ??
						(effectiveToolCallReadOnly
							? requiresSerializedTurn
								? "workflow_state_serialized"
								: pendingBeforeSchedule > 0
									? "read_only_wave"
									: "read_only_wave_start"
							: requiresSerializedTurn
								? "workflow_state_serialized"
								: joinsPathScopedMutationIsland
									? "path_scoped_mutation_disjoint"
									: joinsParallelSafeMutationWave && mcpOptIn
										? "mcp_parallel_opt_in"
										: joinsParallelSafeMutationWave
											? "parallel_safe_mutation_wave"
											: mcpOptIn
												? pendingBeforeSchedule > 0
													? "mcp_parallel_opt_in"
													: "mcp_parallel_opt_in_wave_start"
												: effectiveMutationScope
													? "path_scoped_mutation_wave_start"
													: "serialized_tool");
					const scheduling: ToolSchedulingDecision = {
						callId: toolCall.id,
						toolName: toolCall.name,
						emittedIndex: toolIndex,
						waveIndex,
						decision,
						reason,
						schedulerWaitMs: schedulerWaitMs(),
						mcpOptIn,
						blockedByMutation,
					};
					toolSchedulingDecisions.set(toolCall.id, scheduling);

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
						toolExecutionBridge: platformToolExecutionBridge,
						toolExecutionBridgePlan: safetyVerdict.toolExecutionBridgePlan,
						toolUpdateQueue,
						clientToolExecPromise,
					});
					const trackedExecutionPromise =
						canReuseToolResult && reusableToolResultKey
							? trackReusableToolResult(
									reusableToolResultKey,
									executionPromise,
									reusableToolResults,
									pendingReusableToolResults,
									policyCheckedReusableToolResultKeys,
									reusableToolResultCacheGeneration,
								)
							: executionPromise;

					const pendingExecution: PendingExecution = {
						toolCall,
						promise: trackedExecutionPromise,
					};
					pendingExecutions.push(pendingExecution);
					pendingExecutionWaveIndexes.set(pendingExecution, waveIndex);
					pendingExecutionScheduling.set(pendingExecution, scheduling);
					if (effectiveMutationScope) {
						pendingMutationScopes.set(pendingExecution, effectiveMutationScope);
					}
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
					for (const event of await resolveNextPendingExecution()) {
						yield event;
					}
				}

				if (steeringTriggered && remainingToolCalls.length > 0) {
					for (const toolCall of remainingToolCalls) {
						for (const event of emitSkippedToolCall(toolCall)) {
							yield event;
						}
					}
				}

				const toolPhaseSummary = buildToolPhaseSummary();
				if (toolPhaseSummary) {
					yield toolPhaseSummary;
				}

				this.safetyMiddleware.clearCredentials();

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
			if (encounteredError) {
				cfg.queryProfiler?.terminal("turn:error");
			} else if (!hasMoreToolCalls) {
				cfg.queryProfiler?.terminal("turn:complete", {
					tool_results: toolResults.length,
				});
			}
		}
	}
}
