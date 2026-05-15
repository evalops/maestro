import type { AgentEvent } from "../agent/types.js";
import {
	type PlatformAgentRunStep,
	PlatformAgentRunStepKindValue,
	PlatformAgentRunStepStateValue,
	PlatformAgentRunWaitTypeValue,
	type PlatformAgentWorkItem,
	PlatformAgentWorkItemKindValue,
	PlatformAgentWorkItemStateValue,
	completeAgentRuntimeRun,
	failAgentRuntimeRun,
	recordAgentRuntimeRunStep,
	recordAgentRuntimeRunWorkItem,
	resumeAgentRuntimeRun,
	updateAgentRuntimeRunWorkItem,
	waitAgentRuntimeRun,
} from "../platform/agent-runtime-client.js";
import { createLogger } from "../utils/logger.js";
import type { ServerRequestLifecycleEvent } from "./server-request-manager.js";

const logger = createLogger("server:hosted-agent-runtime-progress");
const CODEX_SUBAGENT_TOOL_PREFIX = "codex.subagent.";

export interface HostedAgentRuntimeProgressContext {
	enabled: true;
	agentRunId?: string;
	agentRuntimeLeaseToken?: string;
	agentRuntimeWorkerQueue?: string;
	agentRuntimeCorrelationPath?: string;
	workspaceId?: string;
	runnerSessionId?: string;
	ownerInstanceId?: string;
}

type ProgressOperation = () => Promise<unknown>;

export interface HostedAgentRuntimeProgressRecorderOperations {
	recordStep?: typeof recordAgentRuntimeRunStep;
	recordWorkItem?: typeof recordAgentRuntimeRunWorkItem;
	updateWorkItem?: typeof updateAgentRuntimeRunWorkItem;
	waitRun?: typeof waitAgentRuntimeRun;
	resumeRun?: typeof resumeAgentRuntimeRun;
	completeRun?: typeof completeAgentRuntimeRun;
	failRun?: typeof failAgentRuntimeRun;
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
}

function safeIdPart(value: string): string {
	return value.replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 96) || "unknown";
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value
		: undefined;
}

function objectKeys(value: unknown): string[] | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const keys = Object.keys(value).sort();
	return keys.length > 0 ? keys : undefined;
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
	return tool || undefined;
}

function codexSubagentNextAction(tool: string): string {
	switch (tool) {
		case "spawnAgent":
			return "wait for child agent initialization or completion";
		case "sendInput":
			return "wait for child agent response";
		case "resumeAgent":
			return "wait for resumed child agent response";
		case "wait":
			return "wait for selected child agents";
		case "closeAgent":
			return "confirm child agent shutdown";
		default:
			return "track Codex subagent collaboration";
	}
}

function toolDisplayName(event: {
	displayName?: string;
	summaryLabel?: string;
	toolName: string;
}): string {
	return event.displayName ?? event.summaryLabel ?? event.toolName;
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

export class HostedAgentRuntimeProgressRecorder {
	private readonly sessionId: string;
	private readonly hostedRunner?: HostedAgentRuntimeProgressContext;
	private readonly workspaceRoot?: string;
	private readonly operations: Required<HostedAgentRuntimeProgressRecorderOperations>;
	private readonly pendingWaitIds = new Map<string, string>();
	private readonly resumedWaitIds = new Set<string>();
	private readonly codexSubagentReceiverThreadIds = new Map<string, string[]>();
	private pending: Promise<void> = Promise.resolve();
	private turnIndex = 0;
	private terminalRecorded = false;

	constructor(options: HostedAgentRuntimeProgressRecorderOptions) {
		this.sessionId = options.sessionId;
		this.hostedRunner = options.hostedRunner;
		this.workspaceRoot = options.workspaceRoot;
		this.operations = {
			recordStep: options.operations?.recordStep ?? recordAgentRuntimeRunStep,
			recordWorkItem:
				options.operations?.recordWorkItem ?? recordAgentRuntimeRunWorkItem,
			updateWorkItem:
				options.operations?.updateWorkItem ?? updateAgentRuntimeRunWorkItem,
			waitRun: options.operations?.waitRun ?? waitAgentRuntimeRun,
			resumeRun: options.operations?.resumeRun ?? resumeAgentRuntimeRun,
			completeRun: options.operations?.completeRun ?? completeAgentRuntimeRun,
			failRun: options.operations?.failRun ?? failAgentRuntimeRun,
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
				return;
			case "tool_execution_start":
				this.recordStep({
					id: this.toolStepId(event.toolCallId),
					name: toolDisplayName(event),
					stepKind: PlatformAgentRunStepKindValue.ToolCallIntent,
					state: PlatformAgentRunStepStateValue.Running,
					input: this.basePayload({
						event_type: event.type,
						tool_call_id: event.toolCallId,
						tool_execution_id: event.toolExecutionId,
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
						tool_execution_id: event.toolExecutionId,
						approval_request_id: event.approvalRequestId,
						tool_name: event.toolName,
						display_name: event.displayName,
						summary_label: event.summaryLabel,
						error_code: event.errorCode,
						governed_outcome: event.governedOutcome,
					}),
				});
				this.updateCodexSubagentWorkItem(event);
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
		const receiverThreadIds = stringArray(event.args.receiverThreadIds);
		this.codexSubagentReceiverThreadIds.set(
			event.toolCallId,
			receiverThreadIds,
		);
		const prompt = nonEmptyString(event.args.prompt);
		const model = nonEmptyString(event.args.model);
		const reasoningEffort = nonEmptyString(event.args.reasoningEffort);
		const workItem: PlatformAgentWorkItem = {
			id: this.workItemId(event.toolCallId),
			runId,
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
			...(event.toolExecutionId
				? { toolExecutionId: event.toolExecutionId }
				: {}),
			evidenceRefs: [
				`codex-tool-call:${event.toolCallId}`,
				...receiverThreadIds.map((id) => `codex-thread:${id}`),
			],
			completionGate: "codex_collab_tool_completed",
			payload: this.basePayload({
				event_type: event.type,
				codex_tool: codexTool,
				tool_call_id: event.toolCallId,
				tool_name: event.toolName,
				display_name: event.displayName,
				summary_label: event.summaryLabel,
				sender_thread_id: nonEmptyString(event.args.senderThreadId),
				receiver_thread_ids: receiverThreadIds,
				receiver_thread_count: receiverThreadIds.length,
				model,
				reasoning_effort: reasoningEffort,
				arg_keys: objectKeys(event.args),
			}),
		};
		this.enqueue(async () => {
			await this.operations.recordWorkItem({ runId, workItem });
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
		const detailReceiverThreadIds = stringArray(details?.receiverThreadIds);
		const receiverThreadIds =
			detailReceiverThreadIds.length > 0
				? detailReceiverThreadIds
				: (this.codexSubagentReceiverThreadIds.get(event.toolCallId) ?? []);
		this.codexSubagentReceiverThreadIds.delete(event.toolCallId);
		this.enqueue(async () => {
			await this.operations.updateWorkItem({
				runId,
				workItemId: this.workItemId(event.toolCallId),
				state: event.isError
					? PlatformAgentWorkItemStateValue.Failed
					: PlatformAgentWorkItemStateValue.Succeeded,
				...(event.toolExecutionId
					? { toolExecutionId: event.toolExecutionId }
					: {}),
				evidenceRefs: [
					`codex-tool-call:${event.toolCallId}`,
					...receiverThreadIds.map((id) => `codex-thread:${id}`),
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
					error_code: event.errorCode,
					governed_outcome: event.governedOutcome,
					result_error: event.isError,
					receiver_thread_ids: receiverThreadIds,
					result_detail_keys: objectKeys(details),
				}),
			});
		});
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
}

export function createHostedAgentRuntimeProgressRecorder(
	options: HostedAgentRuntimeProgressRecorderOptions,
): HostedAgentRuntimeProgressRecorder | undefined {
	if (!options.hostedRunner?.enabled) {
		return undefined;
	}
	return new HostedAgentRuntimeProgressRecorder(options);
}
