import { createHash } from "node:crypto";
import type { SwarmEvent, SwarmTask } from "../agent/swarm/types.js";
import type { AgentEvent, AppMessage, Usage } from "../agent/types.js";
import {
	CODEX_SUBAGENT_TOOL_PREFIX,
	canonicalCodexSubagentTool,
	codexSubagentActiveStatus,
	codexSubagentNextAction as codexSubagentContractNextAction,
	codexSubagentOperationName,
	codexSubagentTerminalSuccessStatus,
} from "../codex/subagent-workgraph.js";
import {
	PlatformDelegationStatusValue,
	delegateAgentWithPlatform,
	resolveAgentDelegationWithPlatform,
} from "../platform/agent-registry-client.js";
import {
	type PlatformAgentRunStep,
	PlatformAgentRunStepKindValue,
	PlatformAgentRunStepStateValue,
	PlatformAgentRunWaitTypeValue,
	type PlatformAgentRuntimeRecordRunEventInput,
	type PlatformAgentWorkItem,
	PlatformAgentWorkItemKindValue,
	PlatformAgentWorkItemStateValue,
	PlatformRuntimeEventTypeValue,
	completeAgentRuntimeRun,
	failAgentRuntimeRun,
	recordAgentRuntimeRunCost,
	recordAgentRuntimeRunEvent,
	recordAgentRuntimeRunStep,
	recordAgentRuntimeRunWorkItem,
	resumeAgentRuntimeRun,
	updateAgentRuntimeRunWorkItem,
	waitAgentRuntimeRun,
} from "../platform/agent-runtime-client.js";
import { createLogger } from "../utils/logger.js";
import type { ServerRequestLifecycleEvent } from "./server-request-manager.js";

const logger = createLogger("server:hosted-agent-runtime-progress");
const CODEX_THREAD_CHILD_RUN_PREFIX = "codex-thread:";
const DEFAULT_CODEX_SUBAGENT_DELEGATION_CAPABILITY = "code:write";

type HostedAgentRuntimeTaskSource =
	| "todo"
	| "background"
	| "swarm"
	| "checkpoint";

type HostedAgentRuntimeTaskStatus =
	| "pending"
	| "running"
	| "waiting"
	| "blocked"
	| "succeeded"
	| "failed"
	| "cancelled";

export interface HostedAgentRuntimeTaskProgressEvent {
	source: HostedAgentRuntimeTaskSource;
	id: string;
	status: HostedAgentRuntimeTaskStatus;
	title: string;
	goal?: string;
	parentId?: string;
	ownerChildRunId?: string;
	workItemKind?: PlatformAgentWorkItemKindValue | string;
	stepKind?: PlatformAgentRunStepKindValue | string;
	nextAction?: string;
	blocker?: string;
	errorMessage?: string;
	toolCallId?: string;
	toolExecutionId?: string;
	approvalRequestId?: string;
	completionGate?: string;
	evidenceRefs?: string[];
	payload?: Record<string, unknown>;
	recordStep?: boolean;
}

export interface HostedAgentRuntimeProgressContext {
	enabled: true;
	agentRunId?: string;
	agentRuntimeLeaseToken?: string;
	agentRuntimeWorkerQueue?: string;
	agentRuntimeCorrelationPath?: string;
	workspaceId?: string;
	runnerSessionId?: string;
	ownerInstanceId?: string;
	agentId?: string;
}

type ProgressOperation = () => Promise<unknown>;

export interface HostedAgentRuntimeProgressRecorderOperations {
	recordStep?: typeof recordAgentRuntimeRunStep;
	recordEvent?: typeof recordAgentRuntimeRunEvent;
	recordCost?: typeof recordAgentRuntimeRunCost;
	recordWorkItem?: typeof recordAgentRuntimeRunWorkItem;
	updateWorkItem?: typeof updateAgentRuntimeRunWorkItem;
	waitRun?: typeof waitAgentRuntimeRun;
	resumeRun?: typeof resumeAgentRuntimeRun;
	completeRun?: typeof completeAgentRuntimeRun;
	failRun?: typeof failAgentRuntimeRun;
	delegateAgent?: typeof delegateAgentWithPlatform;
	resolveDelegation?: typeof resolveAgentDelegationWithPlatform;
}

export interface HostedAgentRuntimeProgressRecorderOptions {
	sessionId: string;
	hostedRunner?: HostedAgentRuntimeProgressContext;
	workspaceRoot?: string;
	operations?: HostedAgentRuntimeProgressRecorderOperations;
}

export interface HostedAgentRuntimeCompleteInput {
	reason?: string;
	requestedBy?: string;
	flushStatus?: string;
	manifestPath?: string;
}

export interface HostedAgentRuntimeFailInput {
	errorMessage: string;
	reason?: string;
	requestedBy?: string;
	retryable?: boolean;
	manifestPath?: string;
	flushStatus?: string;
}

export interface HostedAgentRuntimeDrainInput {
	status: "drained" | "interrupted" | string;
	reason?: string;
	requestedBy?: string;
	flushStatus?: string;
	manifestPath?: string;
	platformEvidence?: unknown;
	errorMessage?: string;
}

function safeIdPart(value: string): string {
	return value.replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 96) || "unknown";
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value
		: undefined;
}

function compactString(value: unknown, maxLength = 256): string | undefined {
	const text = nonEmptyString(value)?.trim();
	if (!text) {
		return undefined;
	}
	if (text.length <= maxLength) {
		return text;
	}
	if (maxLength <= 0) {
		return "";
	}
	if (maxLength <= 3) {
		return ".".repeat(maxLength);
	}
	return `${text.slice(0, maxLength - 3)}...`;
}

function isExistingWorkItemCreateError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /\b409\b|already exists|already_exists|duplicate|unique constraint/i.test(
		message,
	);
}

function stableShortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function goalScopedTodoId(id: string, goal: string | undefined): string {
	return goal ? `goal-${stableShortHash(goal)}:${id}` : id;
}

function swarmCompletionStatus(
	event: Extract<SwarmEvent, { type: "swarm_complete" }>,
): HostedAgentRuntimeTaskStatus {
	switch (event.state.status) {
		case "completed":
			return "succeeded";
		case "failed":
			return "failed";
		case "cancelled":
			return "cancelled";
		case "completing":
			return "running";
		case "initializing":
			return "pending";
		case "running":
			return "running";
	}
}

function objectKeys(value: unknown): string[] | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const keys = Object.keys(value).sort();
	return keys.length > 0 ? keys : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function recordArray(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter(isRecord);
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter(
		(item): item is string => typeof item === "string" && item.length > 0,
	);
}

function codexSubagentToolName(toolName: string): string | undefined {
	const tool = toolName.startsWith(CODEX_SUBAGENT_TOOL_PREFIX)
		? toolName.slice(CODEX_SUBAGENT_TOOL_PREFIX.length)
		: undefined;
	return tool ? (canonicalCodexSubagentTool(tool) ?? tool) : undefined;
}

function codexThreadChildRunId(threadId: string): string {
	return `${CODEX_THREAD_CHILD_RUN_PREFIX}${threadId}`;
}

function codexSubagentWorkGraph(
	args: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	const graph = args?.codexWorkGraph ?? args?.codex_work_graph;
	return isRecord(graph) ? graph : undefined;
}

function codexSubagentWorkGraphChildRuns(
	args: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
	const graph = codexSubagentWorkGraph(args);
	const childRuns = graph?.childRuns ?? graph?.child_runs;
	if (!Array.isArray(childRuns)) {
		return [];
	}
	return childRuns.filter(isRecord);
}

function codexSubagentReceiverThreadIds(
	args: Record<string, unknown>,
): string[] {
	const explicit = stringArray(
		args.receiverThreadIds ?? args.receiver_thread_ids,
	);
	if (explicit.length > 0) {
		return explicit;
	}
	const graphThreadIds = codexSubagentWorkGraphChildRuns(args)
		.map((childRun) => childRun.threadId ?? childRun.thread_id)
		.filter(
			(threadId): threadId is string =>
				typeof threadId === "string" && threadId.length > 0,
		);
	return graphThreadIds;
}

function codexSubagentExplicitChildRunIds(
	args: Record<string, unknown>,
): string[] {
	const explicit = stringArray(args.childRunIds ?? args.child_run_ids);
	if (explicit.length > 0) {
		return explicit;
	}
	const graphChildRunIds = codexSubagentWorkGraphChildRuns(args)
		.map((childRun) => childRun.childRunId ?? childRun.child_run_id)
		.filter(
			(childRunId): childRunId is string =>
				typeof childRunId === "string" && childRunId.length > 0,
		);
	if (graphChildRunIds.length > 0) {
		return graphChildRunIds;
	}
	return [];
}

function codexSubagentChildRunIds(
	args: Record<string, unknown>,
	receiverThreadIds: string[],
): string[] {
	const explicit = codexSubagentExplicitChildRunIds(args);
	if (explicit.length > 0) {
		return explicit;
	}
	return receiverThreadIds.map(codexThreadChildRunId);
}

function codexSubagentNextAction(tool: string): string {
	return (
		codexSubagentContractNextAction(tool) ??
		"track Codex subagent collaboration"
	);
}

function codexSubagentDelegationTargetAgentId(
	args: Record<string, unknown>,
): string | undefined {
	return (
		nonEmptyString(args.toAgentId) ??
		nonEmptyString(args.to_agent_id) ??
		nonEmptyString(args.targetAgentId) ??
		nonEmptyString(args.target_agent_id)
	);
}

function codexSubagentDelegationRequiredCapability(
	args: Record<string, unknown>,
	targetAgentId?: string,
): string | undefined {
	const explicit =
		nonEmptyString(args.requiredCapability) ??
		nonEmptyString(args.required_capability) ??
		nonEmptyString(args.capability);
	return (
		explicit ??
		(targetAgentId ? undefined : DEFAULT_CODEX_SUBAGENT_DELEGATION_CAPABILITY)
	);
}

function codexSubagentDelegationA2ASkillID(
	args: Record<string, unknown>,
	requiredCapability?: string,
): string | undefined {
	const explicit =
		nonEmptyString(args.a2aSkillId) ??
		nonEmptyString(args.a2a_skill_id) ??
		nonEmptyString(args.agentSkillId) ??
		nonEmptyString(args.agent_skill_id) ??
		nonEmptyString(args.subagentSkillId) ??
		nonEmptyString(args.subagent_skill_id) ??
		nonEmptyString(args.skillId) ??
		nonEmptyString(args.skill_id);
	if (explicit) {
		return explicit.trim();
	}
	const subagentType =
		nonEmptyString(args.agentType) ??
		nonEmptyString(args.agent_type) ??
		nonEmptyString(args.subagentType) ??
		nonEmptyString(args.subagent_type);
	return (
		codexSubagentTypeA2ASkillID(subagentType) ??
		codexSubagentCapabilityA2ASkillID(requiredCapability)
	);
}

function codexSubagentTypeA2ASkillID(
	value: string | undefined,
): string | undefined {
	const token = codexSubagentSkillToken(value);
	if (!token) {
		return undefined;
	}
	switch (token) {
		case "pr-review":
		case "review":
		case "reviewer":
		case "code-review":
		case "code-reviewer":
			return "maestro.subagent.code-review";
		case "test":
		case "qa":
		case "ci":
		case "ci-monitor":
		case "test-runner":
			return "maestro.subagent.test-runner";
		case "explore":
		case "explorer":
		case "repo-explorer":
		case "research":
		case "competitive-intel":
		case "people-research":
			return "maestro.subagent.repo-explorer";
		case "release":
		case "release-shepherd":
			return "maestro.subagent.release-shepherd";
		case "worker":
		case "coder":
		case "code":
		case "code-writer":
		case "default":
			return "maestro.subagent.code-writer";
		default:
			return `maestro.subagent.${token}`;
	}
}

function codexSubagentCapabilityA2ASkillID(
	value: string | undefined,
): string | undefined {
	const token = codexSubagentSkillToken(value);
	if (!token) {
		return undefined;
	}
	switch (token) {
		case "code-review":
			return "maestro.subagent.code-review";
		case "code-test":
		case "test-run":
		case "test-runner":
			return "maestro.subagent.test-runner";
		case "repo-explore":
		case "repo-explorer":
		case "code-search":
			return "maestro.subagent.repo-explorer";
		case "release-shepherd":
		case "release-manage":
			return "maestro.subagent.release-shepherd";
		case "code-write":
		case "code-edit":
		case "code-implement":
			return "maestro.subagent.code-writer";
		default:
			return `maestro.subagent.${token}`;
	}
}

function codexSubagentSkillToken(
	value: string | undefined,
): string | undefined {
	const token = value
		?.trim()
		.toLowerCase()
		.replace(/[:_/. ]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-|-$/g, "");
	return token || undefined;
}

function codexSubagentDelegationReason(prompt: string | undefined): string {
	if (!prompt) {
		return "Codex subagent spawn requested by Maestro";
	}
	return `Codex subagent spawn requested by Maestro: ${prompt}`.slice(0, 512);
}

function codexSubagentOperation(tool: string): string | undefined {
	return codexSubagentOperationName(tool);
}

function activeCodexSubagentEdgeStatus(tool: string): string | undefined {
	return codexSubagentActiveStatus(tool);
}

function terminalCodexSubagentEdgeStatus(
	tool: string,
	isError: boolean,
): string | undefined {
	if (isError) {
		return "failed";
	}
	return codexSubagentTerminalSuccessStatus(tool);
}

function shouldResolveCodexSubagentDelegation(
	tool: string,
	isError: boolean,
): boolean {
	if (tool === "wait" || tool === "closeAgent") {
		return true;
	}
	if (tool === "spawnAgent" && isError) {
		return true;
	}
	if (tool === "resumeAgent" && isError) {
		return true;
	}
	return false;
}

function codexSubagentDelegationFailureMessage(tool: string): string {
	switch (tool) {
		case "spawnAgent":
			return "Codex subagent spawn failed";
		case "sendInput":
			return "Codex subagent input failed";
		case "resumeAgent":
			return "Codex subagent resume failed";
		case "wait":
			return "Codex subagent wait failed";
		case "closeAgent":
			return "Codex subagent close failed";
		default:
			return "Codex subagent delegation failed";
	}
}

function toolDisplayName(event: {
	displayName?: string;
	summaryLabel?: string;
	toolName: string;
}): string {
	return event.displayName ?? event.summaryLabel ?? event.toolName;
}

function materializedToolExecutionId(event: {
	toolCallId: string;
	toolExecutionId?: string;
}): string | undefined {
	const toolExecutionId = nonEmptyString(event.toolExecutionId)?.trim();
	const toolCallId = nonEmptyString(event.toolCallId)?.trim();
	if (!toolExecutionId || toolExecutionId === toolCallId) {
		return undefined;
	}
	return toolExecutionId;
}

function waitTypeForRequest(
	kind: ServerRequestLifecycleEvent["request"]["kind"],
): PlatformAgentRunWaitTypeValue {
	switch (kind) {
		case "approval":
		case "tool_retry":
			return PlatformAgentRunWaitTypeValue.Approval;
		case "client_tool":
		case "mcp_elicitation":
		case "user_input":
			return PlatformAgentRunWaitTypeValue.Input;
	}
}

function taskWorkItemState(
	status: HostedAgentRuntimeTaskStatus,
): PlatformAgentWorkItemStateValue {
	switch (status) {
		case "pending":
			return PlatformAgentWorkItemStateValue.Pending;
		case "running":
			return PlatformAgentWorkItemStateValue.Running;
		case "waiting":
			return PlatformAgentWorkItemStateValue.Waiting;
		case "blocked":
			return PlatformAgentWorkItemStateValue.Blocked;
		case "succeeded":
			return PlatformAgentWorkItemStateValue.Succeeded;
		case "failed":
			return PlatformAgentWorkItemStateValue.Failed;
		case "cancelled":
			return PlatformAgentWorkItemStateValue.Cancelled;
	}
}

function taskStepState(
	status: HostedAgentRuntimeTaskStatus,
): PlatformAgentRunStepStateValue {
	switch (status) {
		case "pending":
			return PlatformAgentRunStepStateValue.Pending;
		case "running":
			return PlatformAgentRunStepStateValue.Running;
		case "waiting":
		case "blocked":
			return PlatformAgentRunStepStateValue.Waiting;
		case "succeeded":
			return PlatformAgentRunStepStateValue.Succeeded;
		case "failed":
			return PlatformAgentRunStepStateValue.Failed;
		case "cancelled":
			return PlatformAgentRunStepStateValue.Cancelled;
	}
}

function defaultTaskWorkItemKind(
	source: HostedAgentRuntimeTaskSource,
): PlatformAgentWorkItemKindValue {
	switch (source) {
		case "background":
			return PlatformAgentWorkItemKindValue.ToolCall;
		case "swarm":
			return PlatformAgentWorkItemKindValue.ChildRun;
		case "checkpoint":
			return PlatformAgentWorkItemKindValue.Recovery;
		case "todo":
			return PlatformAgentWorkItemKindValue.Followup;
	}
}

function defaultTaskStepKind(
	source: HostedAgentRuntimeTaskSource,
	status: HostedAgentRuntimeTaskStatus,
): PlatformAgentRunStepKindValue {
	if (status === "failed") {
		return PlatformAgentRunStepKindValue.Error;
	}
	if (source === "background") {
		return status === "succeeded" || status === "cancelled"
			? PlatformAgentRunStepKindValue.ToolResult
			: PlatformAgentRunStepKindValue.ToolCallIntent;
	}
	return PlatformAgentRunStepKindValue.System;
}

function shouldRecordTaskStep(
	event: HostedAgentRuntimeTaskProgressEvent,
): boolean {
	if (event.recordStep !== undefined) {
		return event.recordStep;
	}
	return event.status !== "pending";
}

function backgroundStatusToTaskStatus(
	status: string | undefined,
): HostedAgentRuntimeTaskStatus {
	switch (status) {
		case "running":
		case "restarting":
			return "running";
		case "stopped":
			return "cancelled";
		case "exited":
			return "succeeded";
		case "failed":
			return "failed";
		default:
			return "pending";
	}
}

function todoStatusToTaskStatus(status: unknown): HostedAgentRuntimeTaskStatus {
	switch (status) {
		case "in_progress":
			return "running";
		case "completed":
			return "succeeded";
		default:
			return "pending";
	}
}

function taskPromptSummary(task: SwarmTask): string {
	return compactString(task.prompt, 160) ?? task.id;
}

export class HostedAgentRuntimeProgressRecorder {
	private readonly sessionId: string;
	private readonly hostedRunner?: HostedAgentRuntimeProgressContext;
	private readonly workspaceRoot?: string;
	private readonly operations: Required<HostedAgentRuntimeProgressRecorderOperations>;
	private readonly pendingWaitIds = new Map<string, string>();
	private readonly resumedWaitIds = new Set<string>();
	private readonly codexSubagentReceiverThreadIds = new Map<string, string[]>();
	private readonly codexSubagentToolChildRunIds = new Map<string, string[]>();
	private readonly codexSubagentToolWorkGraphs = new Map<
		string,
		Record<string, unknown>
	>();
	private readonly codexSubagentThreadWorkItemIds = new Map<string, string>();
	private readonly codexSubagentDelegationIds = new Map<string, string>();
	private readonly codexSubagentDelegationIdsByThreadId = new Map<
		string,
		string
	>();
	private readonly codexSubagentDelegationIdsByChildRunId = new Map<
		string,
		string
	>();
	private readonly recordedModelUsageTurnIds = new Set<string>();
	private readonly toolArgsByCallId = new Map<
		string,
		Record<string, unknown>
	>();
	private readonly recordedTaskWorkItemIds = new Set<string>();
	private pending: Promise<void> = Promise.resolve();
	private turnIndex = 0;
	private terminalRecorded = false;

	constructor(options: HostedAgentRuntimeProgressRecorderOptions) {
		this.sessionId = options.sessionId;
		this.hostedRunner = options.hostedRunner;
		this.workspaceRoot = options.workspaceRoot;
		this.operations = {
			recordStep: options.operations?.recordStep ?? recordAgentRuntimeRunStep,
			recordEvent:
				options.operations?.recordEvent ?? recordAgentRuntimeRunEvent,
			recordCost: options.operations?.recordCost ?? recordAgentRuntimeRunCost,
			recordWorkItem:
				options.operations?.recordWorkItem ?? recordAgentRuntimeRunWorkItem,
			updateWorkItem:
				options.operations?.updateWorkItem ?? updateAgentRuntimeRunWorkItem,
			waitRun: options.operations?.waitRun ?? waitAgentRuntimeRun,
			resumeRun: options.operations?.resumeRun ?? resumeAgentRuntimeRun,
			completeRun: options.operations?.completeRun ?? completeAgentRuntimeRun,
			failRun: options.operations?.failRun ?? failAgentRuntimeRun,
			delegateAgent:
				options.operations?.delegateAgent ?? delegateAgentWithPlatform,
			resolveDelegation:
				options.operations?.resolveDelegation ??
				resolveAgentDelegationWithPlatform,
		};
	}

	recordAgentEvent(event: AgentEvent): void {
		switch (event.type) {
			case "agent_start":
				this.recordStep({
					id: this.stepId("agent", `start-${this.turnIndex + 1}`),
					name: event.continuation ? "Agent continuation" : "Agent run",
					stepKind: PlatformAgentRunStepKindValue.System,
					state: PlatformAgentRunStepStateValue.Running,
					input: this.basePayload({
						event_type: event.type,
						continuation: event.continuation ?? false,
					}),
				});
				return;
			case "agent_end":
				this.recordStep({
					id: this.stepId("agent", `end-${this.turnIndex}`),
					name: "Agent run completed",
					stepKind:
						event.aborted || event.stopReason === "error"
							? PlatformAgentRunStepKindValue.Error
							: PlatformAgentRunStepKindValue.System,
					state:
						event.aborted || event.stopReason === "error"
							? PlatformAgentRunStepStateValue.Failed
							: PlatformAgentRunStepStateValue.Succeeded,
					output: this.basePayload({
						event_type: event.type,
						aborted: event.aborted ?? false,
						stop_reason: event.stopReason,
					}),
				});
				return;
			case "turn_start":
				this.turnIndex += 1;
				this.recordStep({
					id: this.stepId("turn", String(this.turnIndex)),
					name: `Turn ${this.turnIndex}`,
					stepKind: PlatformAgentRunStepKindValue.ModelCall,
					state: PlatformAgentRunStepStateValue.Running,
					input: this.basePayload({ event_type: event.type }),
				});
				return;
			case "turn_end":
				this.recordStep({
					id: this.stepId("turn", String(this.turnIndex)),
					name: `Turn ${this.turnIndex}`,
					stepKind: PlatformAgentRunStepKindValue.ModelCall,
					state: PlatformAgentRunStepStateValue.Succeeded,
					output: this.basePayload({
						event_type: event.type,
						tool_result_count: event.toolResults.length,
					}),
				});
				this.recordModelUsageEvent(event.message);
				return;
			case "tool_execution_start":
				this.toolArgsByCallId.set(event.toolCallId, event.args);
				this.recordStep({
					id: this.toolStepId(event.toolCallId),
					name: toolDisplayName(event),
					stepKind: PlatformAgentRunStepKindValue.ToolCallIntent,
					state: PlatformAgentRunStepStateValue.Running,
					input: this.basePayload({
						event_type: event.type,
						tool_call_id: event.toolCallId,
						tool_execution_id: materializedToolExecutionId(event),
						tool_name: event.toolName,
						display_name: event.displayName,
						summary_label: event.summaryLabel,
						arg_keys: objectKeys(event.args),
					}),
				});
				this.recordCodexSubagentWorkItem(event);
				return;
			case "tool_execution_end":
				this.recordStep({
					id: this.toolStepId(event.toolCallId),
					name: toolDisplayName(event),
					stepKind: event.isError
						? PlatformAgentRunStepKindValue.Error
						: PlatformAgentRunStepKindValue.ToolResult,
					state: event.isError
						? PlatformAgentRunStepStateValue.Failed
						: PlatformAgentRunStepStateValue.Succeeded,
					errorMessage: event.isError
						? (event.errorCode ?? event.governedOutcome ?? "tool failed")
						: undefined,
					output: this.basePayload({
						event_type: event.type,
						tool_call_id: event.toolCallId,
						tool_execution_id: materializedToolExecutionId(event),
						approval_request_id: event.approvalRequestId,
						tool_name: event.toolName,
						display_name: event.displayName,
						summary_label: event.summaryLabel,
						error_code: event.errorCode,
						governed_outcome: event.governedOutcome,
					}),
				});
				this.updateCodexSubagentWorkItem(event);
				this.recordToolDerivedTaskProgress(event);
				return;
			case "action_approval_required":
				this.recordApprovalWait({
					id: event.request.id,
					callId: event.request.id,
					toolName: event.request.toolName,
					reason: event.request.reason,
					displayName: event.request.displayName,
					summaryLabel: event.request.summaryLabel,
					startedAtMs: event.request.startedAtMs,
				});
				return;
			case "action_approval_resolved":
				this.resumeWait({
					id: event.request.id,
					kind: "approval",
					resolution: event.decision.approved ? "approved" : "denied",
					resolvedBy: event.decision.resolvedBy ?? "user",
					reason: event.decision.reason,
					startedAtMs: event.request.startedAtMs,
					resolvedAtMs: event.decision.resolvedAtMs,
				});
				return;
			case "error":
				this.recordPromptFailure(event.message);
				return;
			default:
				return;
		}
	}

	recordServerRequestEvent(event: ServerRequestLifecycleEvent): void {
		if (event.type === "registered") {
			this.recordApprovalWait({
				id: event.request.id,
				callId: event.request.callId,
				toolName: event.request.toolName,
				reason: event.request.reason,
				displayName: event.request.displayName,
				summaryLabel: event.request.summaryLabel,
				kind: event.request.kind,
				startedAtMs: event.request.startedAtMs,
			});
			return;
		}
		this.resumeWait({
			id: event.request.id,
			kind: event.request.kind,
			resolution: event.resolution,
			resolvedBy: event.resolvedBy,
			reason: event.reason,
			startedAtMs: event.request.startedAtMs,
			resolvedAtMs: event.resolvedAtMs,
		});
	}

	recordPromptFailure(message: string): void {
		this.recordStep({
			id: this.stepId("error", `${Date.now()}`),
			name: "Prompt failed",
			stepKind: PlatformAgentRunStepKindValue.Error,
			state: PlatformAgentRunStepStateValue.Failed,
			errorMessage: message,
			output: this.basePayload({
				event_type: "prompt_failure",
			}),
		});
	}

	recordTaskProgressEvent(event: HostedAgentRuntimeTaskProgressEvent): void {
		const runId = nonEmptyString(this.hostedRunner?.agentRunId);
		if (!this.hostedRunner?.enabled || !runId) {
			return;
		}
		const taskId = this.taskProgressId(event.source, event.id);
		const parentWorkItemId = event.parentId
			? this.taskProgressId(event.source, event.parentId)
			: undefined;
		const evidenceRefs = [
			`maestro-task:${event.source}:${event.id}`,
			...(event.toolCallId ? [`tool-call:${event.toolCallId}`] : []),
			...(event.toolExecutionId
				? [`tool-execution:${event.toolExecutionId}`]
				: []),
			...(event.evidenceRefs ?? []),
		];
		const state = taskWorkItemState(event.status);
		const payload = this.basePayload({
			event_type: "maestro_task_progress",
			task_source: event.source,
			task_id: event.id,
			task_status: event.status,
			parent_task_id: event.parentId,
			owner_child_run_id: event.ownerChildRunId,
			tool_call_id: event.toolCallId,
			tool_execution_id: event.toolExecutionId,
			approval_request_id: event.approvalRequestId,
			title: compactString(event.title),
			goal: compactString(event.goal, 512),
			next_action: compactString(event.nextAction),
			blocker: compactString(event.blocker),
			...event.payload,
		});
		this.enqueue(async () => {
			const updateWorkItem = () =>
				this.operations.updateWorkItem({
					runId,
					workItemId: taskId,
					state,
					...(event.nextAction
						? { nextAction: compactString(event.nextAction) }
						: {}),
					...(event.blocker ? { blocker: compactString(event.blocker) } : {}),
					...(event.toolExecutionId
						? { toolExecutionId: event.toolExecutionId }
						: {}),
					evidenceRefs,
					completionGate:
						event.completionGate ?? "maestro_task_progress_recorded",
					payload,
				});
			if (this.recordedTaskWorkItemIds.has(taskId)) {
				await updateWorkItem();
				return;
			}
			const workItem = {
				id: taskId,
				runId,
				...(parentWorkItemId ? { parentWorkItemId } : {}),
				...(event.ownerChildRunId
					? { ownerChildRunId: event.ownerChildRunId }
					: {}),
				kind: event.workItemKind ?? defaultTaskWorkItemKind(event.source),
				state,
				title: compactString(event.title),
				...(event.goal ? { goal: compactString(event.goal, 512) } : {}),
				...(event.nextAction
					? { nextAction: compactString(event.nextAction) }
					: {}),
				...(event.blocker ? { blocker: compactString(event.blocker) } : {}),
				...(event.toolExecutionId
					? { toolExecutionId: event.toolExecutionId }
					: {}),
				evidenceRefs,
				completionGate:
					event.completionGate ?? "maestro_task_progress_recorded",
				payload,
			};
			try {
				await this.operations.recordWorkItem({
					runId,
					workItem,
				});
			} catch (error) {
				if (!isExistingWorkItemCreateError(error)) {
					throw error;
				}
				await updateWorkItem();
			}
			this.recordedTaskWorkItemIds.add(taskId);
		});
		this.recordEvent({
			type: PlatformRuntimeEventTypeValue.AgentProgressRecorded,
			message: `Maestro ${event.source} task ${event.status}`,
			stepId: shouldRecordTaskStep(event) ? taskId : undefined,
			attributes: payload,
		});
		if (!shouldRecordTaskStep(event)) {
			return;
		}
		const stepState = taskStepState(event.status);
		const stepKind =
			event.stepKind ?? defaultTaskStepKind(event.source, event.status);
		this.recordStep({
			id: taskId,
			name: compactString(event.title),
			stepKind,
			state: stepState,
			errorMessage: event.status === "failed" ? event.errorMessage : undefined,
			...(stepState === PlatformAgentRunStepStateValue.Running ||
			stepState === PlatformAgentRunStepStateValue.Waiting ||
			stepState === PlatformAgentRunStepStateValue.Pending
				? { input: payload }
				: { output: payload }),
		});
	}

	recordSwarmEvent(event: SwarmEvent): void {
		switch (event.type) {
			case "swarm_start":
				this.recordTaskProgressEvent({
					source: "swarm",
					id: event.swarmId,
					status: "running",
					title: `Swarm ${event.swarmId}`,
					goal: compactString(event.config.planFile, 512),
					workItemKind: PlatformAgentWorkItemKindValue.Root,
					nextAction: "coordinate swarm teammates",
					payload: {
						swarm_id: event.swarmId,
						teammate_count: event.config.teammateCount,
						task_count: event.config.tasks.length,
						mode: event.config.mode,
						model: event.config.model,
						model_provider: event.config.modelProvider,
						subagent_type: event.config.subagentType,
						reasoning_effort: event.config.reasoningEffort,
						continue_on_failure: event.config.continueOnFailure,
					},
				});
				return;
			case "task_start":
				this.recordTaskProgressEvent({
					source: "swarm",
					id: `${event.swarmId}:task:${event.task.id}`,
					parentId: event.swarmId,
					status: "running",
					title: `Swarm task ${event.task.id}`,
					goal: taskPromptSummary(event.task),
					workItemKind: PlatformAgentWorkItemKindValue.ChildRun,
					ownerChildRunId: `swarm:${event.swarmId}:teammate:${event.teammateId}`,
					nextAction: "wait for teammate task completion",
					payload: {
						swarm_id: event.swarmId,
						teammate_id: event.teammateId,
						task_id: event.task.id,
						file_count: event.task.files?.length ?? 0,
						depends_on: event.task.dependsOn,
						model: event.task.model,
						subagent_type: event.task.subagentType,
						priority: event.task.priority,
					},
				});
				return;
			case "task_complete":
				this.recordTaskProgressEvent({
					source: "swarm",
					id: `${event.swarmId}:task:${event.taskId}`,
					parentId: event.swarmId,
					status: "succeeded",
					title: `Swarm task ${event.taskId}`,
					workItemKind: PlatformAgentWorkItemKindValue.ChildRun,
					ownerChildRunId: `swarm:${event.swarmId}:teammate:${event.teammateId}`,
					payload: {
						swarm_id: event.swarmId,
						teammate_id: event.teammateId,
						task_id: event.taskId,
						output_bytes: Buffer.byteLength(event.output, "utf8"),
					},
				});
				return;
			case "task_fail":
				this.recordTaskProgressEvent({
					source: "swarm",
					id: `${event.swarmId}:task:${event.taskId}`,
					parentId: event.swarmId,
					status: "failed",
					title: `Swarm task ${event.taskId}`,
					workItemKind: PlatformAgentWorkItemKindValue.ChildRun,
					ownerChildRunId: `swarm:${event.swarmId}:teammate:${event.teammateId}`,
					errorMessage: event.error,
					payload: {
						swarm_id: event.swarmId,
						teammate_id: event.teammateId,
						task_id: event.taskId,
						error: compactString(event.error, 512),
					},
				});
				return;
			case "swarm_complete":
				this.recordTaskProgressEvent({
					source: "swarm",
					id: event.swarmId,
					status: swarmCompletionStatus(event),
					title: `Swarm ${event.swarmId}`,
					workItemKind: PlatformAgentWorkItemKindValue.Root,
					errorMessage: event.state.error,
					payload: {
						swarm_id: event.swarmId,
						swarm_status: event.state.status,
						completed_task_count: event.state.completedTasks.size,
						failed_task_count: event.state.failedTasks.size,
						teammate_count: event.state.teammates.length,
						error: compactString(event.state.error, 512),
					},
				});
				return;
			case "swarm_fail":
				this.recordTaskProgressEvent({
					source: "swarm",
					id: event.swarmId,
					status: "failed",
					title: `Swarm ${event.swarmId}`,
					workItemKind: PlatformAgentWorkItemKindValue.Root,
					errorMessage: event.error,
					payload: {
						swarm_id: event.swarmId,
						error: compactString(event.error, 512),
					},
				});
				return;
			case "teammate_spawn":
			case "teammate_complete":
				this.recordEvent({
					type: PlatformRuntimeEventTypeValue.AgentProgressRecorded,
					message: `Maestro swarm ${event.type}`,
					attributes: this.basePayload({
						event_type: "maestro_swarm_teammate_progress",
						swarm_id: event.swarmId,
						swarm_event_type: event.type,
						teammate_id: event.teammate.id,
						teammate_name: compactString(event.teammate.name),
						teammate_status: event.teammate.status,
						completed_task_count: event.teammate.completedTasks.length,
					}),
				});
				return;
		}
	}

	async flush(): Promise<void> {
		await this.pending;
	}

	async completeRun(
		input: HostedAgentRuntimeCompleteInput = {},
	): Promise<void> {
		if (this.terminalRecorded) {
			await this.flush();
			return;
		}
		this.terminalRecorded = true;
		this.enqueue(async () => {
			const handles = this.handles();
			if (!handles) {
				return;
			}
			await this.operations.completeRun({
				runId: handles.runId,
				leaseToken: handles.leaseToken,
				result: this.basePayload({
					event_type: "hosted_runner_drained",
					status: "drained",
					flush_status: input.flushStatus,
					reason: input.reason,
					requested_by: input.requestedBy,
					manifest_path: input.manifestPath,
				}),
			});
		});
		await this.flush();
	}

	async failRun(input: HostedAgentRuntimeFailInput): Promise<void> {
		if (this.terminalRecorded) {
			await this.flush();
			return;
		}
		this.terminalRecorded = true;
		this.recordStep({
			id: this.stepId("terminal", "failed"),
			name: "Hosted runner drain failed",
			stepKind: PlatformAgentRunStepKindValue.Error,
			state: PlatformAgentRunStepStateValue.Failed,
			errorMessage: input.errorMessage,
			output: this.basePayload({
				event_type: "hosted_runner_drain_failed",
				reason: input.reason,
				requested_by: input.requestedBy,
				flush_status: input.flushStatus,
				manifest_path: input.manifestPath,
			}),
		});
		this.enqueue(async () => {
			const handles = this.handles();
			if (!handles) {
				return;
			}
			await this.operations.failRun({
				runId: handles.runId,
				leaseToken: handles.leaseToken,
				errorMessage: input.errorMessage,
				retryable: input.retryable ?? false,
			});
		});
		await this.flush();
	}

	async recordHostedRunnerDrain(
		input: HostedAgentRuntimeDrainInput,
	): Promise<void> {
		this.recordDrainManifestEvent(input);
		if (input.status === "drained") {
			await this.completeRun({
				reason: input.reason,
				requestedBy: input.requestedBy,
				flushStatus: input.flushStatus,
				manifestPath: input.manifestPath,
			});
			return;
		}
		await this.failRun({
			errorMessage:
				input.errorMessage ?? "Hosted runner drain did not complete cleanly",
			reason: input.reason,
			requestedBy: input.requestedBy,
			retryable: false,
			flushStatus: input.flushStatus,
			manifestPath: input.manifestPath,
		});
	}

	private recordApprovalWait(input: {
		id: string;
		callId: string;
		toolName: string;
		reason: string;
		displayName?: string;
		summaryLabel?: string;
		kind?: ServerRequestLifecycleEvent["request"]["kind"];
		startedAtMs?: number;
	}): void {
		if (this.pendingWaitIds.has(input.id)) {
			return;
		}
		const waitId = this.waitId(input.id);
		this.pendingWaitIds.set(input.id, waitId);
		this.enqueue(async () => {
			const handles = this.handles();
			if (!handles) {
				return;
			}
			await this.operations.waitRun({
				runId: handles.runId,
				leaseToken: handles.leaseToken,
				wait: {
					id: waitId,
					stepId: this.toolStepId(input.callId),
					type: waitTypeForRequest(input.kind ?? "approval"),
					externalRef: input.id,
					reason: input.reason,
					payload: this.basePayload({
						request_id: input.id,
						request_type: input.kind ?? "approval",
						call_id: input.callId,
						tool_name: input.toolName,
						display_name: input.displayName,
						summary_label: input.summaryLabel,
						started_at_ms: input.startedAtMs,
					}),
				},
				checkpoint: {
					id: this.checkpointId(input.id),
					stepId: this.toolStepId(input.callId),
					resumeToken: waitId,
					payload: this.basePayload({
						request_id: input.id,
						request_type: input.kind ?? "approval",
					}),
				},
			});
		});
	}

	private resumeWait(input: {
		id: string;
		kind: string;
		resolution: string;
		resolvedBy: string;
		reason?: string;
		startedAtMs?: number;
		resolvedAtMs?: number;
	}): void {
		if (this.resumedWaitIds.has(input.id)) {
			return;
		}
		this.resumedWaitIds.add(input.id);
		const waitId = this.pendingWaitIds.get(input.id) ?? this.waitId(input.id);
		this.pendingWaitIds.delete(input.id);
		this.enqueue(async () => {
			const handles = this.handles();
			if (!handles) {
				return;
			}
			await this.operations.resumeRun({
				runId: handles.runId,
				waitId,
				resumeEventId: this.resumeEventId(input.id),
				payload: this.basePayload({
					request_id: input.id,
					request_type: input.kind,
					resolution: input.resolution,
					resolved_by: input.resolvedBy,
					reason: input.reason,
					started_at_ms: input.startedAtMs,
					resolved_at_ms: input.resolvedAtMs,
				}),
			});
		});
	}

	private recordStep(step: PlatformAgentRunStep): void {
		this.enqueue(async () => {
			const handles = this.handles();
			if (!handles) {
				return;
			}
			await this.operations.recordStep({
				runId: handles.runId,
				leaseToken: handles.leaseToken,
				step,
			});
		});
	}

	private recordModelUsageEvent(message: AppMessage): void {
		if (message.role !== "assistant") {
			return;
		}
		const usage = message.usage as Usage | undefined;
		if (!usage) {
			return;
		}
		const inputTokens = finiteNumber(usage.input);
		const outputTokens = finiteNumber(usage.output);
		const cacheReadTokens = finiteNumber(usage.cacheRead);
		const cacheWriteTokens = finiteNumber(usage.cacheWrite);
		const totalTokens =
			inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
		const estimatedCostMicros = Math.max(
			0,
			Math.round(finiteNumber(usage.cost?.total) * 1_000_000),
		);
		if (totalTokens <= 0 && estimatedCostMicros <= 0) {
			return;
		}
		const turnId = String(this.turnIndex);
		if (this.recordedModelUsageTurnIds.has(turnId)) {
			return;
		}
		this.recordedModelUsageTurnIds.add(turnId);
		const modelCallId = this.stepId("model", turnId);
		const costId = this.costId(turnId);
		const stepId = this.stepId("turn", turnId);
		const meterRef = this.meterRef(costId);
		this.recordEvent({
			type: PlatformRuntimeEventTypeValue.ModelResponseRecorded,
			message: "Maestro model response usage recorded",
			stepId,
			costId,
			attributes: this.basePayload({
				event_type: "model_response_recorded",
				session_kind: "codex",
				session_provider: "maestro",
				model_call_id: modelCallId,
				cost_id: costId,
				provider: message.provider,
				model: message.model,
				input_tokens: inputTokens,
				output_tokens: outputTokens,
				cache_read_tokens: cacheReadTokens,
				cache_write_tokens: cacheWriteTokens,
				total_tokens: totalTokens,
				estimated_cost_micros: estimatedCostMicros,
				currency: "USD",
			}),
		});
		this.recordCost({
			id: costId,
			stepId,
			meterRef,
			provider: message.provider,
			model: message.model,
			inputTokens,
			outputTokens,
			totalTokens,
			currency: estimatedCostMicros > 0 ? "USD" : undefined,
			estimatedCostMicros,
		});
	}

	private recordDrainManifestEvent(input: HostedAgentRuntimeDrainInput): void {
		this.recordEvent({
			type: PlatformRuntimeEventTypeValue.AgentProgressRecorded,
			message:
				input.status === "drained"
					? "hosted runner drain manifest recorded"
					: "hosted runner interrupted drain manifest recorded",
			attributes: this.basePayload({
				event_type: "hosted_runner_drain_manifest_recorded",
				status: input.status,
				flush_status: input.flushStatus,
				reason: input.reason,
				requested_by: input.requestedBy,
				manifest_path: input.manifestPath,
				error: input.errorMessage,
				platform_evidence: input.platformEvidence,
			}),
		});
	}

	private recordEvent(
		event: Omit<PlatformAgentRuntimeRecordRunEventInput, "runId">,
	): void {
		this.enqueue(async () => {
			const runId = nonEmptyString(this.hostedRunner?.agentRunId);
			if (!this.hostedRunner?.enabled || !runId) {
				return;
			}
			await this.operations.recordEvent({
				runId,
				...event,
			});
		});
	}

	private recordCost(
		cost: Parameters<typeof recordAgentRuntimeRunCost>[0]["cost"],
	): void {
		this.enqueue(async () => {
			const runId = nonEmptyString(this.hostedRunner?.agentRunId);
			const leaseToken = nonEmptyString(
				this.hostedRunner?.agentRuntimeLeaseToken,
			);
			if (!this.hostedRunner?.enabled || !runId || !leaseToken) {
				return;
			}
			await this.operations.recordCost({
				runId,
				leaseToken,
				cost,
			});
		});
	}

	private recordCodexSubagentWorkItem(
		event: Extract<AgentEvent, { type: "tool_execution_start" }>,
	): void {
		const codexTool = codexSubagentToolName(event.toolName);
		if (!codexTool) {
			return;
		}
		const runId = nonEmptyString(this.hostedRunner?.agentRunId);
		if (!this.hostedRunner?.enabled || !runId) {
			return;
		}
		const workGraph = codexSubagentWorkGraph(event.args);
		const receiverThreadIds = codexSubagentReceiverThreadIds(event.args);
		const childRunIds = codexSubagentChildRunIds(event.args, receiverThreadIds);
		const ownerChildRunId = childRunIds[0];
		const linkedWorkItemIds =
			this.codexSubagentLinkedWorkItemIds(receiverThreadIds);
		const parentWorkItemId =
			linkedWorkItemIds.length === 1 ? linkedWorkItemIds[0] : undefined;
		const workItemId = this.workItemId(event.toolCallId);
		this.codexSubagentReceiverThreadIds.set(
			event.toolCallId,
			receiverThreadIds,
		);
		this.codexSubagentToolChildRunIds.set(event.toolCallId, childRunIds);
		if (workGraph) {
			this.codexSubagentToolWorkGraphs.set(event.toolCallId, workGraph);
		}
		if (codexTool === "spawnAgent") {
			for (const threadId of receiverThreadIds) {
				this.codexSubagentThreadWorkItemIds.set(threadId, workItemId);
			}
		}
		const toolExecutionId = materializedToolExecutionId(event);
		const prompt = nonEmptyString(event.args.prompt);
		const model = nonEmptyString(event.args.model);
		const reasoningEffort = nonEmptyString(event.args.reasoningEffort);
		const codexSubagentOperationName = codexSubagentOperation(codexTool);
		const workItem: PlatformAgentWorkItem = {
			id: workItemId,
			runId,
			...(parentWorkItemId ? { parentWorkItemId } : {}),
			...(ownerChildRunId ? { ownerChildRunId } : {}),
			kind:
				codexTool === "wait"
					? PlatformAgentWorkItemKindValue.Wait
					: PlatformAgentWorkItemKindValue.ChildRun,
			state:
				codexTool === "wait"
					? PlatformAgentWorkItemStateValue.Waiting
					: PlatformAgentWorkItemStateValue.Running,
			title: toolDisplayName(event),
			...(prompt ? { goal: prompt } : {}),
			nextAction: codexSubagentNextAction(codexTool),
			...(toolExecutionId ? { toolExecutionId } : {}),
			evidenceRefs: [
				`codex-tool-call:${event.toolCallId}`,
				...receiverThreadIds.map((id) => `codex-thread:${id}`),
				...childRunIds.map((id) => `codex-child-run:${id}`),
			],
			completionGate: "codex_collab_tool_completed",
			payload: this.basePayload({
				event_type: event.type,
				codex_tool: codexTool,
				tool_call_id: event.toolCallId,
				tool_name: event.toolName,
				display_name: event.displayName,
				summary_label: event.summaryLabel,
				codex_subagent_operation: codexSubagentOperationName,
				codex_subagent_edge_status: activeCodexSubagentEdgeStatus(codexTool),
				sender_thread_id: nonEmptyString(event.args.senderThreadId),
				receiver_thread_ids: receiverThreadIds,
				receiver_thread_count: receiverThreadIds.length,
				child_run_ids: childRunIds,
				codex_work_graph: workGraph,
				linked_work_item_ids: linkedWorkItemIds,
				model,
				reasoning_effort: reasoningEffort,
				arg_keys: objectKeys(event.args),
			}),
		};
		this.enqueue(async () => {
			await this.operations.recordWorkItem({ runId, workItem });
		});
		if (codexTool === "spawnAgent") {
			this.recordCodexSubagentDelegation({
				event,
				runId,
				workItemId,
				parentWorkItemId,
				ownerChildRunId,
				receiverThreadIds,
				childRunIds,
				linkedWorkItemIds,
				workGraph,
				prompt,
				model,
				reasoningEffort,
			});
		}
	}

	private recordCodexSubagentDelegation(input: {
		event: Extract<AgentEvent, { type: "tool_execution_start" }>;
		runId: string;
		workItemId: string;
		parentWorkItemId?: string;
		ownerChildRunId?: string;
		receiverThreadIds: string[];
		childRunIds: string[];
		linkedWorkItemIds: string[];
		workGraph?: Record<string, unknown>;
		prompt?: string;
		model?: string;
		reasoningEffort?: string;
	}): void {
		const fromAgentId = nonEmptyString(this.hostedRunner?.agentId) ?? "maestro";
		const toAgentId = codexSubagentDelegationTargetAgentId(input.event.args);
		const requiredCapability = codexSubagentDelegationRequiredCapability(
			input.event.args,
			toAgentId,
		);
		const a2aSkillId = codexSubagentDelegationA2ASkillID(
			input.event.args,
			requiredCapability,
		);
		this.enqueue(async () => {
			const result = await this.operations.delegateAgent({
				fromAgentId,
				...(toAgentId ? { toAgentId } : {}),
				...(requiredCapability ? { requiredCapability } : {}),
				...(a2aSkillId ? { a2aSkillId } : {}),
				contextPayload: this.basePayload({
					event_type: "codex_subagent_delegation_requested",
					codex_tool: "spawnAgent",
					agent_run_id: input.runId,
					work_item_id: input.workItemId,
					parent_work_item_id: input.parentWorkItemId,
					owner_child_run_id: input.ownerChildRunId,
					tool_call_id: input.event.toolCallId,
					tool_name: input.event.toolName,
					display_name: input.event.displayName,
					summary_label: input.event.summaryLabel,
					from_agent_id: fromAgentId,
					to_agent_id: toAgentId,
					required_capability: requiredCapability,
					a2a_skill_id: a2aSkillId,
					sender_thread_id: nonEmptyString(input.event.args.senderThreadId),
					receiver_thread_ids: input.receiverThreadIds,
					child_run_ids: input.childRunIds,
					codex_work_graph: input.workGraph,
					linked_work_item_ids: input.linkedWorkItemIds,
					prompt: input.prompt,
					model: input.model,
					reasoning_effort: input.reasoningEffort,
					arg_keys: objectKeys(input.event.args),
				}),
				reason: codexSubagentDelegationReason(input.prompt),
			});
			const delegationId = result?.delegation?.id;
			if (delegationId) {
				this.rememberCodexSubagentDelegation({
					delegationId,
					toolCallId: input.event.toolCallId,
					receiverThreadIds: input.receiverThreadIds,
					childRunIds: input.childRunIds,
				});
			}
		});
	}

	private updateCodexSubagentWorkItem(
		event: Extract<AgentEvent, { type: "tool_execution_end" }>,
	): void {
		const codexTool = codexSubagentToolName(event.toolName);
		if (!codexTool) {
			return;
		}
		const runId = nonEmptyString(this.hostedRunner?.agentRunId);
		if (!this.hostedRunner?.enabled || !runId) {
			return;
		}
		const details =
			event.result.details &&
			typeof event.result.details === "object" &&
			!Array.isArray(event.result.details)
				? (event.result.details as Record<string, unknown>)
				: undefined;
		const detailWorkGraph = codexSubagentWorkGraph(details);
		const workGraph =
			detailWorkGraph ?? this.codexSubagentToolWorkGraphs.get(event.toolCallId);
		const detailReceiverThreadIds = details
			? codexSubagentReceiverThreadIds(details)
			: [];
		const receiverThreadIds =
			detailReceiverThreadIds.length > 0
				? detailReceiverThreadIds
				: (this.codexSubagentReceiverThreadIds.get(event.toolCallId) ?? []);
		const detailChildRunIds = details
			? codexSubagentExplicitChildRunIds(details)
			: [];
		const childRunIds =
			detailChildRunIds.length > 0
				? detailChildRunIds
				: (this.codexSubagentToolChildRunIds.get(event.toolCallId) ??
					codexSubagentChildRunIds({}, receiverThreadIds));
		const linkedWorkItemIds =
			this.codexSubagentLinkedWorkItemIds(receiverThreadIds);
		this.codexSubagentReceiverThreadIds.delete(event.toolCallId);
		this.codexSubagentToolChildRunIds.delete(event.toolCallId);
		this.codexSubagentToolWorkGraphs.delete(event.toolCallId);
		if (codexTool === "closeAgent" && !event.isError) {
			for (const threadId of receiverThreadIds) {
				this.codexSubagentThreadWorkItemIds.delete(threadId);
			}
		}
		const codexSubagentOperationName = codexSubagentOperation(codexTool);
		const codexSubagentEdgeStatus = terminalCodexSubagentEdgeStatus(
			codexTool,
			event.isError,
		);
		this.enqueue(async () => {
			const delegationIds = this.codexSubagentDelegationIdsFor(
				event.toolCallId,
				receiverThreadIds,
				childRunIds,
			);
			const delegationId = delegationIds[0];
			const delegationEvidenceRefs = delegationIds.map(
				(id) => `agent-registry-delegation:${id}`,
			);
			const shouldResolveDelegation =
				delegationIds.length > 0 &&
				shouldResolveCodexSubagentDelegation(codexTool, event.isError);
			const toolExecutionId = materializedToolExecutionId(event);
			let updateError: unknown;
			try {
				await this.operations.updateWorkItem({
					runId,
					workItemId: this.workItemId(event.toolCallId),
					state: event.isError
						? PlatformAgentWorkItemStateValue.Failed
						: PlatformAgentWorkItemStateValue.Succeeded,
					...(toolExecutionId ? { toolExecutionId } : {}),
					evidenceRefs: [
						`codex-tool-call:${event.toolCallId}`,
						...receiverThreadIds.map((id) => `codex-thread:${id}`),
						...childRunIds.map((id) => `codex-child-run:${id}`),
						...delegationEvidenceRefs,
					],
					completionGate: event.isError
						? "codex_collab_tool_failed"
						: "codex_collab_tool_completed",
					payload: this.basePayload({
						event_type: event.type,
						codex_tool: codexTool,
						tool_call_id: event.toolCallId,
						tool_name: event.toolName,
						display_name: event.displayName,
						summary_label: event.summaryLabel,
						codex_subagent_operation: codexSubagentOperationName,
						codex_subagent_edge_status: codexSubagentEdgeStatus,
						error_code: event.errorCode,
						governed_outcome: event.governedOutcome,
						result_error: event.isError,
						receiver_thread_ids: receiverThreadIds,
						child_run_ids: childRunIds,
						codex_work_graph: workGraph,
						linked_work_item_ids: linkedWorkItemIds,
						delegation_id: delegationId,
						delegation_ids:
							delegationIds.length > 0 ? delegationIds : undefined,
						delegation_resolution:
							codexTool === "spawnAgent" &&
							delegationIds.length > 0 &&
							!event.isError
								? "deferred_until_child_terminal_edge"
								: shouldResolveDelegation
									? "resolved_from_child_terminal_edge"
									: undefined,
						result_detail_keys: objectKeys(details),
					}),
				});
			} catch (error) {
				updateError = error;
			}
			if (shouldResolveDelegation) {
				for (const delegationIdToResolve of delegationIds) {
					try {
						await this.operations.resolveDelegation({
							delegationId: delegationIdToResolve,
							status: event.isError
								? PlatformDelegationStatusValue.Failed
								: PlatformDelegationStatusValue.Completed,
							resultPayload: this.basePayload({
								event_type: "codex_subagent_delegation_resolved",
								codex_tool: codexTool,
								codex_subagent_operation: codexSubagentOperationName,
								codex_subagent_edge_status: codexSubagentEdgeStatus,
								agent_run_id: runId,
								work_item_id: this.workItemId(event.toolCallId),
								resolution_tool_call_id: event.toolCallId,
								tool_call_id: event.toolCallId,
								tool_name: event.toolName,
								result_error: event.isError,
								receiver_thread_ids: receiverThreadIds,
								child_run_ids: childRunIds,
								codex_work_graph: workGraph,
								linked_work_item_ids: linkedWorkItemIds,
								delegation_ids: delegationIds,
								result_detail_keys: objectKeys(details),
							}),
							errorMessage: event.isError
								? (event.errorCode ??
									event.governedOutcome ??
									codexSubagentDelegationFailureMessage(codexTool))
								: undefined,
						});
					} catch (error) {
						logger.warn("Failed to resolve Codex subagent delegation", {
							error: error instanceof Error ? error.message : String(error),
							session_id: this.sessionId,
							agent_run_id: runId,
							tool_call_id: event.toolCallId,
							delegation_id: delegationIdToResolve,
						});
					} finally {
						this.clearCodexSubagentDelegationLinks(delegationIdToResolve);
					}
				}
			}
			if (updateError !== undefined) {
				throw updateError;
			}
		});
	}

	private rememberCodexSubagentDelegation(input: {
		delegationId: string;
		toolCallId: string;
		receiverThreadIds: string[];
		childRunIds: string[];
	}): void {
		this.codexSubagentDelegationIds.set(input.toolCallId, input.delegationId);
		for (const threadId of input.receiverThreadIds) {
			this.codexSubagentDelegationIdsByThreadId.set(
				threadId,
				input.delegationId,
			);
		}
		for (const childRunId of input.childRunIds) {
			this.codexSubagentDelegationIdsByChildRunId.set(
				childRunId,
				input.delegationId,
			);
		}
	}

	private codexSubagentDelegationIdsFor(
		toolCallId: string,
		receiverThreadIds: string[],
		childRunIds: string[],
	): string[] {
		const ids = new Set<string>();
		const add = (delegationId: string | undefined) => {
			if (delegationId) {
				ids.add(delegationId);
			}
		};
		add(this.codexSubagentDelegationIds.get(toolCallId));
		for (const childRunId of childRunIds) {
			add(this.codexSubagentDelegationIdsByChildRunId.get(childRunId));
		}
		for (const threadId of receiverThreadIds) {
			add(this.codexSubagentDelegationIdsByThreadId.get(threadId));
		}
		return [...ids];
	}

	private clearCodexSubagentDelegationLinks(delegationId: string): void {
		for (const [toolCallId, linkedDelegationId] of this
			.codexSubagentDelegationIds) {
			if (linkedDelegationId === delegationId) {
				this.codexSubagentDelegationIds.delete(toolCallId);
			}
		}
		for (const [threadId, linkedDelegationId] of this
			.codexSubagentDelegationIdsByThreadId) {
			if (linkedDelegationId === delegationId) {
				this.codexSubagentDelegationIdsByThreadId.delete(threadId);
			}
		}
		for (const [childRunId, linkedDelegationId] of this
			.codexSubagentDelegationIdsByChildRunId) {
			if (linkedDelegationId === delegationId) {
				this.codexSubagentDelegationIdsByChildRunId.delete(childRunId);
			}
		}
	}

	private codexSubagentLinkedWorkItemIds(
		receiverThreadIds: string[],
	): string[] {
		const linked = receiverThreadIds
			.map((threadId) => this.codexSubagentThreadWorkItemIds.get(threadId))
			.filter((id): id is string => Boolean(id));
		return Array.from(new Set(linked));
	}

	private recordToolDerivedTaskProgress(
		event: Extract<AgentEvent, { type: "tool_execution_end" }>,
	): void {
		const args = this.toolArgsByCallId.get(event.toolCallId);
		this.toolArgsByCallId.delete(event.toolCallId);
		if (event.isError) {
			return;
		}
		if (event.toolName === "todo") {
			this.recordTodoTaskProgress(event, args);
			return;
		}
		if (event.toolName === "background_tasks" || event.toolName === "bash") {
			this.recordBackgroundTaskProgress(event, args);
		}
	}

	private recordTodoTaskProgress(
		event: Extract<AgentEvent, { type: "tool_execution_end" }>,
		args: Record<string, unknown> | undefined,
	): void {
		const details = isRecord(event.result.details)
			? event.result.details
			: undefined;
		if (!details) {
			return;
		}
		const rawGoal = nonEmptyString(args?.goal)?.trim();
		const goal = compactString(rawGoal, 512);
		const goalHash = rawGoal ? stableShortHash(rawGoal) : undefined;
		for (const item of recordArray(details.items)) {
			const id = compactString(item.id, 128);
			const content = compactString(item.content, 512);
			if (!id || !content) {
				continue;
			}
			const scopedId = goalScopedTodoId(id, rawGoal);
			const blockedBy = stringArray(item.blockedBy);
			const status = todoStatusToTaskStatus(item.status);
			this.recordTaskProgressEvent({
				source: "todo",
				id: scopedId,
				status,
				title: content,
				goal,
				toolCallId: event.toolCallId,
				toolExecutionId: materializedToolExecutionId(event),
				completionGate: "todo_status_projected",
				nextAction:
					status === "pending"
						? "wait for task to start"
						: status === "running"
							? "complete the active task"
							: "task completed",
				blocker: blockedBy.length > 0 ? blockedBy.join(", ") : undefined,
				payload: {
					task_id: id,
					todo_id: id,
					todo_scope: rawGoal ? "goal" : "session",
					todo_goal_hash: goalHash,
					todo_status: compactString(item.status),
					priority: compactString(item.priority),
					blocked_by: blockedBy,
					due: compactString(item.due),
				},
			});
		}
	}

	private recordBackgroundTaskProgress(
		event: Extract<AgentEvent, { type: "tool_execution_end" }>,
		args: Record<string, unknown> | undefined,
	): void {
		const details = event.result.details;
		const candidates = Array.isArray(details)
			? recordArray(details)
			: isRecord(details)
				? [details]
				: [];
		for (const detail of candidates) {
			const id = compactString(detail.id ?? detail.taskId, 128);
			if (!id) {
				continue;
			}
			const statusLabel = compactString(detail.status, 64);
			if (!statusLabel) {
				continue;
			}
			const command = compactString(detail.command ?? args?.command, 512);
			const status = backgroundStatusToTaskStatus(statusLabel);
			this.recordTaskProgressEvent({
				source: "background",
				id,
				status,
				title: command
					? `Background task: ${command}`
					: `Background task ${id}`,
				toolCallId: event.toolCallId,
				toolExecutionId: materializedToolExecutionId(event),
				completionGate: "background_task_status_projected",
				nextAction:
					status === "running"
						? "monitor or stop the background task"
						: "inspect task result if needed",
				errorMessage: compactString(detail.failureReason, 512),
				payload: {
					background_task_id: id,
					background_task_status: statusLabel,
					command_summary: command,
					cwd: compactString(detail.cwd, 512),
					pid: typeof detail.pid === "number" ? detail.pid : undefined,
					shell_mode: compactString(detail.shellMode, 64),
					restart_attempts: finiteNumber(detail.restartAttempts),
					restart_max_attempts: finiteNumber(detail.restartMaxAttempts),
					log_truncated:
						typeof detail.logTruncated === "boolean"
							? detail.logTruncated
							: undefined,
					monitoring_mode: compactString(detail.monitoringMode, 64),
				},
			});
		}
	}

	private enqueue(operation: ProgressOperation): void {
		this.pending = this.pending.then(operation, operation).then(
			() => {},
			(error) => {
				logger.warn("Failed to record hosted AgentRuntime progress", {
					error: error instanceof Error ? error.message : String(error),
					session_id: this.sessionId,
					agent_run_id: this.hostedRunner?.agentRunId,
				});
			},
		);
	}

	private handles(): { runId: string; leaseToken: string } | null {
		const runId = nonEmptyString(this.hostedRunner?.agentRunId);
		const leaseToken = nonEmptyString(
			this.hostedRunner?.agentRuntimeLeaseToken,
		);
		if (!this.hostedRunner?.enabled || !runId || !leaseToken) {
			return null;
		}
		return { runId, leaseToken };
	}

	private basePayload(
		values: Record<string, unknown>,
	): Record<string, unknown> {
		return {
			maestro_session_id: this.sessionId,
			...(this.workspaceRoot ? { workspace_root: this.workspaceRoot } : {}),
			...(this.hostedRunner?.workspaceId
				? { workspace_id: this.hostedRunner.workspaceId }
				: {}),
			...(this.hostedRunner?.runnerSessionId
				? { runner_session_id: this.hostedRunner.runnerSessionId }
				: {}),
			...(this.hostedRunner?.ownerInstanceId
				? { owner_instance_id: this.hostedRunner.ownerInstanceId }
				: {}),
			...(this.hostedRunner?.agentId
				? { agent_id: this.hostedRunner.agentId }
				: {}),
			...(this.hostedRunner?.agentRuntimeWorkerQueue
				? { worker_queue: this.hostedRunner.agentRuntimeWorkerQueue }
				: {}),
			...(this.hostedRunner?.agentRuntimeCorrelationPath
				? { correlation_path: this.hostedRunner.agentRuntimeCorrelationPath }
				: {}),
			...Object.fromEntries(
				Object.entries(values).filter(([, value]) => value !== undefined),
			),
		};
	}

	private stepId(kind: string, id: string): string {
		return `maestro:${safeIdPart(this.sessionId)}:${kind}:${safeIdPart(id)}`;
	}

	private taskProgressId(
		source: HostedAgentRuntimeTaskSource,
		id: string,
	): string {
		return this.stepId(source, id);
	}

	private toolStepId(toolCallId: string): string {
		return this.stepId("tool", toolCallId);
	}

	private workItemId(toolCallId: string): string {
		return this.stepId("work", toolCallId);
	}

	private waitId(requestId: string): string {
		return this.stepId("wait", requestId);
	}

	private checkpointId(requestId: string): string {
		return this.stepId("checkpoint", requestId);
	}

	private resumeEventId(requestId: string): string {
		return this.stepId("resume", requestId);
	}

	private costId(turnId: string): string {
		return this.stepId("cost", turnId);
	}

	private meterRef(costId: string): string {
		return `meter://maestro/model-usage/${safeIdPart(costId)}`;
	}
}

export function createHostedAgentRuntimeProgressRecorder(
	options: HostedAgentRuntimeProgressRecorderOptions,
): HostedAgentRuntimeProgressRecorder | undefined {
	if (!options.hostedRunner?.enabled) {
		return undefined;
	}
	return new HostedAgentRuntimeProgressRecorder(options);
}
