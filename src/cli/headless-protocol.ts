import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import {
	type HeadlessApprovalMode,
	type HeadlessConnectionRole,
	type HeadlessErrorType,
	type HeadlessNotificationType,
	type HeadlessServerRequestResolution,
	type HeadlessServerRequestResolvedBy,
	type HeadlessServerRequestType,
	type HeadlessThinkingLevel,
	type HeadlessUtilityCommandShellMode,
	type HeadlessUtilityCommandStream,
	type HeadlessUtilityCommandTerminalMode,
	type HeadlessUtilityFileWatchChangeType,
	type HeadlessUtilityOperation,
	headlessProtocolVersion,
} from "@evalops/contracts";
import { lookup as lookupMimeType } from "mime-types";

import type { ActionApprovalService } from "../agent/action-approval.js";
import type { Agent } from "../agent/index.js";
import type {
	AgentEvent,
	AgentToolResult,
	AppMessage,
	AssistantMessage,
	AssistantMessageEvent,
	Attachment,
} from "../agent/types.js";
import { appendHeadlessOutput } from "../headless/output-buffer.js";
import type { SessionManager } from "../session/manager.js";
import { isSupportedImageFormat } from "../tools/image-processor.js";
import { getCurrentBranch, isInsideGitRepository } from "../utils/git.js";
import { normalizePath } from "../utils/path-validation.js";
import { summarizeToolUse } from "../utils/tool-use-summary.js";

export interface HeadlessPromptMessage {
	type: "prompt";
	content: string;
	attachments?: string[];
}

export interface HeadlessInitMessage {
	type: "init";
	system_prompt?: string;
	append_system_prompt?: string;
	thinking_level?: HeadlessThinkingLevel;
	approval_mode?: HeadlessApprovalMode;
}

export interface HeadlessClientInfo {
	name: string;
	version?: string;
}

export interface HeadlessClientCapabilities {
	server_requests?: HeadlessServerRequestType[];
	utility_operations?: HeadlessUtilityOperation[];
}

export interface HeadlessHelloMessage {
	type: "hello";
	protocol_version?: string;
	client_info?: HeadlessClientInfo;
	capabilities?: HeadlessClientCapabilities;
	role?: HeadlessConnectionRole;
	opt_out_notifications?: HeadlessNotificationType[];
}

export interface HeadlessInterruptMessage {
	type: "interrupt";
}

export interface HeadlessToolResponseMessage {
	type: "tool_response";
	call_id: string;
	approved: boolean;
	result?: {
		success: boolean;
		output: string;
		error?: string;
	};
}

export interface HeadlessClientToolResultMessage {
	type: "client_tool_result";
	call_id: string;
	content: Array<
		| {
				type: "text";
				text: string;
		  }
		| {
				type: "image";
				data: string;
				mimeType: string;
		  }
	>;
	is_error: boolean;
}

export interface HeadlessServerRequestResponseMessage {
	type: "server_request_response";
	request_id: string;
	request_type: HeadlessServerRequestType;
	approved?: boolean;
	result?: {
		success: boolean;
		output: string;
		error?: string;
	};
	content?: Array<
		| {
				type: "text";
				text: string;
		  }
		| {
				type: "image";
				data: string;
				mimeType: string;
		  }
	>;
	is_error?: boolean;
}

export interface HeadlessUtilityCommandStartMessage {
	type: "utility_command_start";
	command_id: string;
	command: string;
	cwd?: string;
	env?: Record<string, string>;
	shell_mode?: HeadlessUtilityCommandShellMode;
	terminal_mode?: HeadlessUtilityCommandTerminalMode;
	allow_stdin?: boolean;
	columns?: number;
	rows?: number;
}

export interface HeadlessUtilityCommandTerminateMessage {
	type: "utility_command_terminate";
	command_id: string;
	force?: boolean;
}

export interface HeadlessUtilityCommandStdinMessage {
	type: "utility_command_stdin";
	command_id: string;
	content: string;
	eof?: boolean;
}

export interface HeadlessUtilityCommandResizeMessage {
	type: "utility_command_resize";
	command_id: string;
	columns: number;
	rows: number;
}

export interface HeadlessUtilityFileSearchMessage {
	type: "utility_file_search";
	search_id: string;
	query: string;
	cwd?: string;
	limit?: number;
}

export interface HeadlessUtilityFileWatchStartMessage {
	type: "utility_file_watch_start";
	watch_id: string;
	root_dir?: string;
	include_patterns?: string[];
	exclude_patterns?: string[];
	debounce_ms?: number;
}

export interface HeadlessUtilityFileWatchStopMessage {
	type: "utility_file_watch_stop";
	watch_id: string;
}

export interface HeadlessCancelMessage {
	type: "cancel";
}

export interface HeadlessShutdownMessage {
	type: "shutdown";
}

export type HeadlessToAgentMessage =
	| HeadlessHelloMessage
	| HeadlessInitMessage
	| HeadlessPromptMessage
	| HeadlessInterruptMessage
	| HeadlessToolResponseMessage
	| HeadlessClientToolResultMessage
	| HeadlessServerRequestResponseMessage
	| HeadlessUtilityCommandStartMessage
	| HeadlessUtilityCommandTerminateMessage
	| HeadlessUtilityCommandStdinMessage
	| HeadlessUtilityCommandResizeMessage
	| HeadlessUtilityFileSearchMessage
	| HeadlessUtilityFileWatchStartMessage
	| HeadlessUtilityFileWatchStopMessage
	| HeadlessCancelMessage
	| HeadlessShutdownMessage;

export interface HeadlessReadyMessage {
	type: "ready";
	protocol_version: string;
	model: string;
	provider: string;
	session_id: string | null;
}

export interface HeadlessResponseStartMessage {
	type: "response_start";
	response_id: string;
}

export interface HeadlessResponseChunkMessage {
	type: "response_chunk";
	response_id: string;
	content: string;
	is_thinking: boolean;
}

export interface HeadlessResponseEndMessage {
	type: "response_end";
	response_id: string;
	usage: {
		input_tokens: number;
		output_tokens: number;
		cache_read_tokens: number;
		cache_write_tokens: number;
		total_tokens: number;
		total_cost_usd: number;
		model_id: string;
		provider: string;
	};
	tools_summary: {
		tools_used: string[];
		calls_succeeded: number;
		calls_failed: number;
		summary_labels?: string[];
	};
	duration_ms: number;
	ttft_ms?: number;
}

export interface HeadlessToolCallMessage {
	type: "tool_call";
	call_id: string;
	tool: string;
	args: Record<string, unknown> | unknown;
	requires_approval: boolean;
}

export interface HeadlessToolStartMessage {
	type: "tool_start";
	call_id: string;
}

export interface HeadlessToolOutputMessage {
	type: "tool_output";
	call_id: string;
	content: string;
}

export interface HeadlessToolEndMessage {
	type: "tool_end";
	call_id: string;
	success: boolean;
}

export interface HeadlessClientToolRequestMessage {
	type: "client_tool_request";
	call_id: string;
	tool: string;
	args: unknown;
}

export interface HeadlessServerRequestMessage {
	type: "server_request";
	request_id: string;
	request_type: HeadlessServerRequestType;
	call_id: string;
	tool: string;
	args: unknown;
	reason: string;
}

export interface HeadlessServerRequestResolvedMessage {
	type: "server_request_resolved";
	request_id: string;
	request_type: HeadlessServerRequestType;
	call_id: string;
	resolution: HeadlessServerRequestResolution;
	reason?: string;
	resolved_by: HeadlessServerRequestResolvedBy;
}

export interface HeadlessUtilityCommandStartedMessage {
	type: "utility_command_started";
	command_id: string;
	command: string;
	cwd?: string;
	shell_mode: HeadlessUtilityCommandShellMode;
	terminal_mode: HeadlessUtilityCommandTerminalMode;
	pid?: number;
	columns?: number;
	rows?: number;
	owner_connection_id?: string;
}

export interface HeadlessUtilityCommandResizedMessage {
	type: "utility_command_resized";
	command_id: string;
	columns: number;
	rows: number;
}

export interface HeadlessUtilityCommandOutputMessage {
	type: "utility_command_output";
	command_id: string;
	stream: HeadlessUtilityCommandStream;
	content: string;
}

export interface HeadlessUtilityCommandExitedMessage {
	type: "utility_command_exited";
	command_id: string;
	success: boolean;
	exit_code?: number | null;
	signal?: string | null;
	reason?: string;
}

export interface HeadlessUtilityFileSearchMatch {
	path: string;
	score: number;
}

export interface HeadlessUtilityFileSearchResultsMessage {
	type: "utility_file_search_results";
	search_id: string;
	query: string;
	cwd: string;
	results: HeadlessUtilityFileSearchMatch[];
	truncated: boolean;
}

export interface HeadlessUtilityFileWatchStartedMessage {
	type: "utility_file_watch_started";
	watch_id: string;
	root_dir: string;
	include_patterns?: string[];
	exclude_patterns?: string[];
	debounce_ms: number;
	owner_connection_id?: string;
}

export interface HeadlessUtilityFileWatchEventMessage {
	type: "utility_file_watch_event";
	watch_id: string;
	change_type: HeadlessUtilityFileWatchChangeType;
	path: string;
	relative_path: string;
	timestamp: number;
	is_directory: boolean;
}

export interface HeadlessUtilityFileWatchStoppedMessage {
	type: "utility_file_watch_stopped";
	watch_id: string;
	reason?: string;
}

export interface HeadlessErrorMessage {
	type: "error";
	message: string;
	fatal: boolean;
	error_type: HeadlessErrorType;
}

export interface HeadlessStatusMessage {
	type: "status";
	message: string;
}

export interface HeadlessCompactionMessage {
	type: "compaction";
	summary: string;
	first_kept_entry_index: number;
	tokens_before: number;
	auto: boolean;
	custom_instructions?: string;
	timestamp: string;
}

export interface HeadlessSessionInfoMessage {
	type: "session_info";
	session_id: string | null;
	cwd: string;
	git_branch: string | null;
}

export interface HeadlessConnectionInfoMessage {
	type: "connection_info";
	connection_id?: string;
	client_protocol_version?: string;
	client_info?: HeadlessClientInfo;
	capabilities?: HeadlessClientCapabilities;
	opt_out_notifications?: HeadlessNotificationType[];
	role?: HeadlessConnectionRole;
	connection_count?: number;
	controller_connection_id?: string | null;
	lease_expires_at?: string | null;
	connections?: HeadlessConnectionState[];
}

export type HeadlessFromAgentMessage =
	| HeadlessReadyMessage
	| HeadlessResponseStartMessage
	| HeadlessResponseChunkMessage
	| HeadlessResponseEndMessage
	| HeadlessToolCallMessage
	| HeadlessToolStartMessage
	| HeadlessToolOutputMessage
	| HeadlessToolEndMessage
	| HeadlessClientToolRequestMessage
	| HeadlessServerRequestMessage
	| HeadlessServerRequestResolvedMessage
	| HeadlessUtilityCommandStartedMessage
	| HeadlessUtilityCommandResizedMessage
	| HeadlessUtilityCommandOutputMessage
	| HeadlessUtilityCommandExitedMessage
	| HeadlessUtilityFileSearchResultsMessage
	| HeadlessUtilityFileWatchStartedMessage
	| HeadlessUtilityFileWatchEventMessage
	| HeadlessUtilityFileWatchStoppedMessage
	| HeadlessErrorMessage
	| HeadlessStatusMessage
	| HeadlessCompactionMessage
	| HeadlessSessionInfoMessage
	| HeadlessConnectionInfoMessage;

export interface HeadlessStreamingResponseState {
	response_id: string;
	text: string;
	thinking: string;
	usage?: HeadlessResponseEndMessage["usage"];
}

export interface HeadlessPendingApprovalState {
	call_id: string;
	tool: string;
	args: unknown;
}

export interface HeadlessActiveToolState {
	call_id: string;
	tool: string;
	output: string;
}

export interface HeadlessActiveUtilityCommandState {
	command_id: string;
	command: string;
	cwd?: string;
	shell_mode: HeadlessUtilityCommandShellMode;
	terminal_mode: HeadlessUtilityCommandTerminalMode;
	pid?: number;
	columns?: number;
	rows?: number;
	owner_connection_id?: string;
	output: string;
}

export interface HeadlessActiveFileWatchState {
	watch_id: string;
	root_dir: string;
	include_patterns?: string[];
	exclude_patterns?: string[];
	debounce_ms: number;
	owner_connection_id?: string;
}

export interface HeadlessConnectionState {
	connection_id: string;
	role: HeadlessConnectionRole;
	client_protocol_version?: string;
	client_info?: HeadlessClientInfo;
	capabilities?: HeadlessClientCapabilities;
	opt_out_notifications?: HeadlessNotificationType[];
	subscription_count: number;
	attached_subscription_count: number;
	controller_lease_granted: boolean;
	lease_expires_at?: string | null;
}

export interface HeadlessRuntimeState {
	protocol_version?: string;
	client_protocol_version?: string;
	client_info?: HeadlessClientInfo;
	capabilities?: HeadlessClientCapabilities;
	opt_out_notifications?: HeadlessNotificationType[];
	connection_role?: HeadlessConnectionRole;
	connection_count: number;
	subscriber_count: number;
	controller_subscription_id?: string | null;
	controller_connection_id?: string | null;
	connections: HeadlessConnectionState[];
	model?: string;
	provider?: string;
	session_id?: string | null;
	cwd?: string;
	git_branch?: string | null;
	current_response?: HeadlessStreamingResponseState;
	pending_approvals: HeadlessPendingApprovalState[];
	pending_client_tools: HeadlessPendingApprovalState[];
	pending_user_inputs: HeadlessPendingApprovalState[];
	active_tools: HeadlessActiveToolState[];
	active_utility_commands: HeadlessActiveUtilityCommandState[];
	active_file_watches: HeadlessActiveFileWatchState[];
	tracked_tools: HeadlessPendingApprovalState[];
	last_error?: string;
	last_error_type?: HeadlessErrorMessage["error_type"];
	last_status?: string;
	last_response_duration_ms?: number;
	last_ttft_ms?: number;
	is_ready: boolean;
	is_responding: boolean;
}

export const HEADLESS_PROTOCOL_VERSION = headlessProtocolVersion;

export function createHeadlessRuntimeState(): HeadlessRuntimeState {
	return {
		connection_count: 0,
		subscriber_count: 0,
		connections: [],
		pending_approvals: [],
		pending_client_tools: [],
		pending_user_inputs: [],
		active_tools: [],
		active_utility_commands: [],
		active_file_watches: [],
		tracked_tools: [],
		is_ready: false,
		is_responding: false,
	};
}

const MAX_HEADLESS_ATTACHMENT_BYTES =
	Number.parseInt(
		process.env.MAESTRO_HEADLESS_MAX_ATTACHMENT_BYTES || "",
		10,
	) || 10 * 1024 * 1024;
const MAX_TEXT_ATTACHMENT_CHARS =
	Number.parseInt(process.env.MAESTRO_HEADLESS_MAX_TEXT_CHARS || "", 10) ||
	200_000;

function generateMessageId(): string {
	return `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function classifyHeadlessError(
	message: string,
	fatal: boolean,
): "transient" | "fatal" | "tool" | "cancelled" | "protocol" {
	const normalized = message.toLowerCase();
	if (
		normalized.includes("abort") ||
		normalized.includes("interrupted") ||
		normalized.includes("cancel")
	) {
		return "cancelled";
	}
	if (
		normalized.includes("rate limit") ||
		normalized.includes("overloaded") ||
		normalized.includes("timeout") ||
		normalized.includes("temporar")
	) {
		return "transient";
	}
	if (
		normalized.includes("tool") ||
		normalized.includes("permission") ||
		normalized.includes("approval")
	) {
		return "tool";
	}
	if (
		normalized.includes("parse") ||
		normalized.includes("json") ||
		normalized.includes("protocol")
	) {
		return "protocol";
	}
	return fatal ? "fatal" : "tool";
}

export function buildHeadlessUsage(
	message: AssistantMessage,
	model: string,
	provider: string,
) {
	const usage = message.usage;
	const inputTokens = usage?.input ?? 0;
	const outputTokens = usage?.output ?? 0;
	const cacheReadTokens = usage?.cacheRead ?? 0;
	const cacheWriteTokens = usage?.cacheWrite ?? 0;
	const totalTokens =
		inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
	const totalCostUsd = usage?.cost?.total ?? 0;
	return {
		input_tokens: inputTokens,
		output_tokens: outputTokens,
		cache_read_tokens: cacheReadTokens,
		cache_write_tokens: cacheWriteTokens,
		total_tokens: totalTokens,
		total_cost_usd: totalCostUsd,
		model_id: model,
		provider,
	};
}

export function buildHeadlessToolsSummary(params: {
	toolsUsed: Set<string>;
	callsSucceeded: number;
	callsFailed: number;
	summaryLabels: string[];
}) {
	return {
		tools_used: [...params.toolsUsed].sort(),
		calls_succeeded: params.callsSucceeded,
		calls_failed: params.callsFailed,
		summary_labels:
			params.summaryLabels.length > 0 ? params.summaryLabels : undefined,
	};
}

export function buildHeadlessCompactionMessage(
	event: Extract<AgentEvent, { type: "compaction" }>,
): HeadlessCompactionMessage {
	return {
		type: "compaction",
		summary: event.summary,
		first_kept_entry_index: event.firstKeptEntryIndex,
		tokens_before: event.tokensBefore,
		auto: Boolean(event.auto),
		custom_instructions: event.customInstructions,
		timestamp: event.timestamp,
	};
}

type ResponseTelemetry = {
	responseId: string;
	startedAtMs: number;
	firstChunkAtMs?: number;
	toolsUsed: Set<string>;
	toolSummaryLabels: string[];
	callsSucceeded: number;
	callsFailed: number;
};

function extractToolResultText(partialResult: AgentToolResult): string {
	const fragments: string[] = [];
	for (const block of partialResult.content) {
		if (block.type === "text") {
			fragments.push(block.text);
			continue;
		}
		if (block.type === "image") {
			fragments.push(`[image:${block.mimeType ?? "unknown"}]`);
		}
	}
	return fragments.join("\n");
}

export class HeadlessProtocolTranslator {
	private currentMessageId = "";
	private currentResponseTelemetry: ResponseTelemetry | null = null;

	private noteResponseChunk(): void {
		if (
			this.currentResponseTelemetry &&
			!this.currentResponseTelemetry.firstChunkAtMs
		) {
			this.currentResponseTelemetry.firstChunkAtMs = Date.now();
		}
	}

	private noteToolExecution(
		toolName: string,
		args?: Record<string, unknown>,
		succeeded?: boolean,
	): void {
		if (!this.currentResponseTelemetry) {
			return;
		}
		this.currentResponseTelemetry.toolsUsed.add(toolName);
		if (succeeded === true) {
			this.currentResponseTelemetry.callsSucceeded += 1;
		}
		if (succeeded === false) {
			this.currentResponseTelemetry.callsFailed += 1;
		}
		if (args) {
			const summary = summarizeToolUse(toolName, args);
			if (
				summary &&
				!this.currentResponseTelemetry.toolSummaryLabels.includes(summary)
			) {
				this.currentResponseTelemetry.toolSummaryLabels.push(summary);
			}
		}
	}

	private buildResponseEndMessage(
		message: AssistantMessage,
		model: string,
		provider: string,
	): HeadlessResponseEndMessage {
		const telemetry = this.currentResponseTelemetry ?? {
			responseId: this.currentMessageId || generateMessageId(),
			startedAtMs: Date.now(),
			toolsUsed: new Set<string>(),
			toolSummaryLabels: [],
			callsSucceeded: 0,
			callsFailed: 0,
		};
		const now = Date.now();

		return {
			type: "response_end",
			response_id: telemetry.responseId,
			usage: buildHeadlessUsage(message, model, provider),
			tools_summary: buildHeadlessToolsSummary({
				toolsUsed: telemetry.toolsUsed,
				callsSucceeded: telemetry.callsSucceeded,
				callsFailed: telemetry.callsFailed,
				summaryLabels: telemetry.toolSummaryLabels,
			}),
			duration_ms: Math.max(0, now - telemetry.startedAtMs),
			ttft_ms: telemetry.firstChunkAtMs
				? Math.max(0, telemetry.firstChunkAtMs - telemetry.startedAtMs)
				: undefined,
		};
	}

	private handleAssistantMessageEvent(
		event: AssistantMessageEvent,
		messageId: string,
	): HeadlessFromAgentMessage[] {
		switch (event.type) {
			case "text_delta":
				this.noteResponseChunk();
				return [
					{
						type: "response_chunk",
						response_id: messageId,
						content: event.delta,
						is_thinking: false,
					},
				];
			case "thinking_delta":
				this.noteResponseChunk();
				return [
					{
						type: "response_chunk",
						response_id: messageId,
						content: event.delta,
						is_thinking: true,
					},
				];
			default:
				return [];
		}
	}

	handleAgentEvent(event: AgentEvent): HeadlessFromAgentMessage[] {
		switch (event.type) {
			case "message_start":
				if (event.message.role !== "assistant") {
					return [];
				}
				this.currentMessageId = generateMessageId();
				this.currentResponseTelemetry = {
					responseId: this.currentMessageId,
					startedAtMs: Date.now(),
					toolsUsed: new Set<string>(),
					toolSummaryLabels: [],
					callsSucceeded: 0,
					callsFailed: 0,
				};
				return [
					{
						type: "response_start",
						response_id: this.currentMessageId,
					},
				];
			case "message_update":
				return this.handleAssistantMessageEvent(
					event.assistantMessageEvent,
					this.currentMessageId,
				);
			case "message_end": {
				if (event.message.role !== "assistant") {
					return [];
				}
				const responseEnd = this.buildResponseEndMessage(
					event.message as AssistantMessage,
					event.message.model,
					event.message.provider,
				);
				this.currentResponseTelemetry = null;
				return [responseEnd];
			}
			case "tool_execution_start":
				this.noteToolExecution(event.toolName, event.args);
				return [
					{
						type: "tool_call",
						call_id: event.toolCallId,
						tool: event.toolName,
						args: event.args,
						requires_approval: false,
					},
					{
						type: "tool_start",
						call_id: event.toolCallId,
					},
				];
			case "tool_execution_update": {
				const content = extractToolResultText(event.partialResult);
				if (!content) {
					return [];
				}
				return [
					{
						type: "tool_output",
						call_id: event.toolCallId,
						content,
					},
				];
			}
			case "tool_execution_end":
				this.noteToolExecution(event.toolName, undefined, !event.isError);
				return [
					{
						type: "tool_end",
						call_id: event.toolCallId,
						success: !event.isError,
					},
				];
			case "action_approval_required":
				return [
					{
						type: "tool_call",
						call_id: event.request.id,
						tool: event.request.toolName,
						args: event.request.args,
						requires_approval: true,
					},
					{
						type: "server_request",
						request_id: event.request.id,
						request_type: "approval",
						call_id: event.request.id,
						tool: event.request.toolName,
						args: event.request.args,
						reason: event.request.reason,
					},
				];
			case "error":
				return [
					{
						type: "error",
						message: event.message,
						fatal: false,
						error_type: classifyHeadlessError(event.message, false),
					},
				];
			case "status":
				return [
					{
						type: "status",
						message: event.status,
					},
				];
			case "compaction":
				return [buildHeadlessCompactionMessage(event)];
			case "client_tool_request": {
				const requestType =
					event.toolName === "ask_user" ? "user_input" : "client_tool";
				const reason =
					requestType === "user_input"
						? "Agent requested structured user input"
						: `Client tool ${event.toolName} requires local execution`;
				return [
					{
						type: "client_tool_request",
						call_id: event.toolCallId,
						tool: event.toolName,
						args: event.args,
					},
					{
						type: "server_request",
						request_id: event.toolCallId,
						request_type: requestType,
						call_id: event.toolCallId,
						tool: event.toolName,
						args: event.args,
						reason,
					},
				];
			}
			case "agent_start":
			case "agent_end":
			case "turn_start":
			case "turn_end":
			case "tool_retry_required":
			case "tool_retry_resolved":
				return [];
			case "action_approval_resolved":
				return [
					{
						type: "server_request_resolved",
						request_id: event.request.id,
						request_type: "approval",
						call_id: event.request.id,
						resolution: event.decision.approved ? "approved" : "denied",
						reason: event.decision.reason,
						resolved_by: event.decision.resolvedBy,
					},
				];
			default:
				return [];
		}
	}

	buildReadyMessage(
		agent: Agent,
		sessionManager: SessionManager,
	): HeadlessReadyMessage {
		const model = agent.state.model;
		return {
			type: "ready",
			protocol_version: HEADLESS_PROTOCOL_VERSION,
			model: model.id,
			provider: model.provider,
			session_id: sessionManager.getSessionId() ?? null,
		};
	}

	buildSessionInfoMessage(
		sessionManager: SessionManager,
	): HeadlessSessionInfoMessage {
		const cwd = process.cwd();
		const gitBranch = isInsideGitRepository()
			? (getCurrentBranch() ?? null)
			: null;
		return {
			type: "session_info",
			session_id: sessionManager.getSessionId() ?? null,
			cwd,
			git_branch: gitBranch,
		};
	}

	buildConnectionInfoMessage(metadata: {
		connection_id?: string;
		protocol_version?: string;
		client_info?: HeadlessClientInfo;
		capabilities?: HeadlessClientCapabilities;
		opt_out_notifications?: HeadlessNotificationType[];
		role?: HeadlessConnectionRole;
		connection_count?: number;
		controller_connection_id?: string | null;
		lease_expires_at?: string | null;
		connections?: HeadlessConnectionState[];
	}): HeadlessConnectionInfoMessage {
		return {
			type: "connection_info",
			connection_id: metadata.connection_id,
			client_protocol_version: metadata.protocol_version,
			client_info: metadata.client_info,
			capabilities: metadata.capabilities,
			opt_out_notifications: metadata.opt_out_notifications,
			role: metadata.role,
			connection_count: metadata.connection_count,
			controller_connection_id: metadata.controller_connection_id,
			lease_expires_at: metadata.lease_expires_at,
			connections: metadata.connections,
		};
	}
}

export function applyInitMessage(
	agent: Agent,
	msg: HeadlessInitMessage,
	approvalService?: ActionApprovalService,
): string[] {
	const applied: string[] = [];

	if (typeof msg.system_prompt === "string") {
		agent.setSystemPrompt(msg.system_prompt);
		applied.push("system_prompt");
	}

	if (typeof msg.append_system_prompt === "string") {
		const nextPrompt = agent.state.systemPrompt
			? `${agent.state.systemPrompt}\n\n${msg.append_system_prompt}`
			: msg.append_system_prompt;
		agent.setSystemPrompt(nextPrompt);
		applied.push("append_system_prompt");
	}

	if (msg.thinking_level) {
		agent.setThinkingLevel(msg.thinking_level);
		applied.push("thinking_level");
	}

	if (msg.approval_mode && approvalService) {
		approvalService.setMode(msg.approval_mode);
		applied.push("approval_mode");
	}

	return applied;
}

export async function loadPromptAttachments(
	paths: string[],
	onError: (message: string, fatal: boolean) => void,
): Promise<Attachment[]> {
	const attachments: Attachment[] = [];

	for (const rawPath of paths) {
		const absolutePath = normalizePath(rawPath);

		try {
			await access(absolutePath, constants.R_OK);
		} catch {
			onError(`Attachment not readable: ${rawPath}`, false);
			continue;
		}

		let fileStats: Awaited<ReturnType<typeof stat>>;
		try {
			fileStats = await stat(absolutePath);
		} catch {
			onError(`Attachment not found: ${rawPath}`, false);
			continue;
		}

		if (fileStats.size > MAX_HEADLESS_ATTACHMENT_BYTES) {
			onError(
				`Attachment too large (${Math.round(
					fileStats.size / (1024 * 1024),
				)}MB): ${rawPath}`,
				false,
			);
			continue;
		}

		const buffer = await readFile(absolutePath);
		const fileName = basename(absolutePath);
		const lookedUp = lookupMimeType(absolutePath);
		const mimeType =
			(typeof lookedUp === "string" ? lookedUp : null) ??
			"application/octet-stream";

		const id = `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

		if (isSupportedImageFormat(absolutePath) || mimeType.startsWith("image/")) {
			attachments.push({
				id,
				type: "image",
				fileName,
				mimeType,
				size: fileStats.size,
				content: buffer.toString("base64"),
			});
			continue;
		}

		const text = buffer.toString("utf-8");
		if (!text || text.includes("\u0000")) {
			onError(`Unsupported attachment (not image/text): ${rawPath}`, false);
			continue;
		}

		attachments.push({
			id,
			type: "document",
			fileName,
			mimeType,
			size: fileStats.size,
			content: buffer.toString("base64"),
			extractedText:
				text.length > MAX_TEXT_ATTACHMENT_CHARS
					? text.slice(0, MAX_TEXT_ATTACHMENT_CHARS)
					: text,
		});
	}

	return attachments;
}

export function applyOutgoingHeadlessMessage(
	state: HeadlessRuntimeState,
	msg: HeadlessToAgentMessage,
): void {
	switch (msg.type) {
		case "hello":
			state.client_protocol_version = msg.protocol_version;
			state.client_info = msg.client_info;
			state.capabilities = msg.capabilities;
			state.opt_out_notifications = msg.opt_out_notifications;
			state.connection_role = msg.role ?? state.connection_role ?? "controller";
			state.connection_count = 1;
			state.controller_connection_id =
				state.connection_role === "controller" ? "local" : null;
			state.connections = [
				{
					connection_id: "local",
					role: state.connection_role,
					client_protocol_version: msg.protocol_version,
					client_info: msg.client_info,
					capabilities: msg.capabilities,
					opt_out_notifications: msg.opt_out_notifications,
					subscription_count: 1,
					attached_subscription_count: 1,
					controller_lease_granted: state.connection_role === "controller",
					lease_expires_at: null,
				},
			];
			return;
		case "init":
			return;
		case "prompt":
			state.current_response = undefined;
			state.last_error = undefined;
			state.last_error_type = undefined;
			state.last_status = undefined;
			state.is_responding = true;
			return;
		case "tool_response":
			state.pending_approvals = state.pending_approvals.filter(
				(approval) => approval.call_id !== msg.call_id,
			);
			if (!msg.approved) {
				state.tracked_tools = state.tracked_tools.filter(
					(tool) => tool.call_id !== msg.call_id,
				);
			}
			return;
		case "client_tool_result":
			state.pending_client_tools = state.pending_client_tools.filter(
				(request) => request.call_id !== msg.call_id,
			);
			state.pending_user_inputs = state.pending_user_inputs.filter(
				(request) => request.call_id !== msg.call_id,
			);
			return;
		case "utility_command_start":
		case "utility_command_terminate":
		case "utility_command_stdin":
		case "utility_command_resize":
		case "utility_file_search":
		case "utility_file_watch_start":
		case "utility_file_watch_stop":
			return;
		case "server_request_response":
			if (msg.request_type === "approval") {
				state.pending_approvals = state.pending_approvals.filter(
					(approval) => approval.call_id !== msg.request_id,
				);
				if (!msg.approved) {
					state.tracked_tools = state.tracked_tools.filter(
						(tool) => tool.call_id !== msg.request_id,
					);
				}
			} else if (msg.request_type === "client_tool") {
				state.pending_client_tools = state.pending_client_tools.filter(
					(request) => request.call_id !== msg.request_id,
				);
			} else {
				state.pending_user_inputs = state.pending_user_inputs.filter(
					(request) => request.call_id !== msg.request_id,
				);
			}
			return;
		case "interrupt":
		case "cancel":
			state.current_response = undefined;
			state.pending_approvals = [];
			state.pending_client_tools = [];
			state.pending_user_inputs = [];
			state.active_tools = [];
			state.active_utility_commands = [];
			state.active_file_watches = [];
			state.tracked_tools = [];
			state.is_responding = false;
			return;
		case "shutdown":
			state.current_response = undefined;
			state.pending_approvals = [];
			state.pending_client_tools = [];
			state.pending_user_inputs = [];
			state.active_tools = [];
			state.active_utility_commands = [];
			state.active_file_watches = [];
			state.tracked_tools = [];
			state.is_ready = false;
			state.is_responding = false;
			return;
	}
}

export function applyIncomingHeadlessMessage(
	state: HeadlessRuntimeState,
	msg: HeadlessFromAgentMessage,
): void {
	switch (msg.type) {
		case "ready":
			state.protocol_version = msg.protocol_version;
			state.model = msg.model;
			state.provider = msg.provider;
			state.session_id = msg.session_id;
			state.is_ready = true;
			return;
		case "connection_info":
			state.client_protocol_version = msg.client_protocol_version;
			state.client_info = msg.client_info;
			state.capabilities = msg.capabilities;
			state.opt_out_notifications = msg.opt_out_notifications;
			state.connection_role = msg.role;
			state.connection_count =
				msg.connection_count ?? msg.connections?.length ?? 0;
			state.controller_connection_id = msg.controller_connection_id;
			state.connections = msg.connections ?? state.connections;
			return;
		case "session_info":
			state.session_id = msg.session_id;
			state.cwd = msg.cwd;
			state.git_branch = msg.git_branch;
			return;
		case "response_start":
			state.current_response = {
				response_id: msg.response_id,
				text: "",
				thinking: "",
			};
			state.is_responding = true;
			return;
		case "response_chunk":
			if (state.current_response?.response_id === msg.response_id) {
				if (msg.is_thinking) {
					state.current_response.thinking += msg.content;
				} else {
					state.current_response.text += msg.content;
				}
			}
			return;
		case "response_end":
			if (state.current_response?.response_id === msg.response_id) {
				state.current_response.usage = msg.usage;
			}
			state.last_response_duration_ms = msg.duration_ms;
			state.last_ttft_ms = msg.ttft_ms;
			state.current_response = undefined;
			state.is_responding = false;
			return;
		case "tool_call":
			state.tracked_tools = [
				...state.tracked_tools.filter((tool) => tool.call_id !== msg.call_id),
				{
					call_id: msg.call_id,
					tool: msg.tool,
					args: msg.args,
				},
			];
			if (msg.requires_approval) {
				state.pending_approvals = [
					...state.pending_approvals.filter(
						(approval) => approval.call_id !== msg.call_id,
					),
					{
						call_id: msg.call_id,
						tool: msg.tool,
						args: msg.args,
					},
				];
			}
			return;
		case "tool_start": {
			const tracked = state.tracked_tools.find(
				(tool) => tool.call_id === msg.call_id,
			);
			const pending = state.pending_approvals.find(
				(approval) => approval.call_id === msg.call_id,
			);
			const pendingClientTool = state.pending_client_tools.find(
				(request) => request.call_id === msg.call_id,
			);
			const pendingUserInput = state.pending_user_inputs.find(
				(request) => request.call_id === msg.call_id,
			);
			state.active_tools = [
				...state.active_tools.filter((tool) => tool.call_id !== msg.call_id),
				{
					call_id: msg.call_id,
					tool:
						tracked?.tool ??
						pending?.tool ??
						pendingClientTool?.tool ??
						pendingUserInput?.tool ??
						"unknown",
					output: "",
				},
			];
			return;
		}
		case "tool_output":
			state.active_tools = state.active_tools.map((tool) =>
				tool.call_id === msg.call_id
					? { ...tool, output: `${tool.output}${msg.content}` }
					: tool,
			);
			return;
		case "tool_end":
			state.active_tools = state.active_tools.filter(
				(tool) => tool.call_id !== msg.call_id,
			);
			state.pending_approvals = state.pending_approvals.filter(
				(approval) => approval.call_id !== msg.call_id,
			);
			state.pending_client_tools = state.pending_client_tools.filter(
				(request) => request.call_id !== msg.call_id,
			);
			state.pending_user_inputs = state.pending_user_inputs.filter(
				(request) => request.call_id !== msg.call_id,
			);
			state.tracked_tools = state.tracked_tools.filter(
				(tool) => tool.call_id !== msg.call_id,
			);
			return;
		case "client_tool_request":
			state.tracked_tools = [
				...state.tracked_tools.filter((tool) => tool.call_id !== msg.call_id),
				{
					call_id: msg.call_id,
					tool: msg.tool,
					args: msg.args,
				},
			];
			if (msg.tool === "ask_user") {
				state.pending_user_inputs = [
					...state.pending_user_inputs.filter(
						(request) => request.call_id !== msg.call_id,
					),
					{
						call_id: msg.call_id,
						tool: msg.tool,
						args: msg.args,
					},
				];
			} else {
				state.pending_client_tools = [
					...state.pending_client_tools.filter(
						(request) => request.call_id !== msg.call_id,
					),
					{
						call_id: msg.call_id,
						tool: msg.tool,
						args: msg.args,
					},
				];
			}
			return;
		case "server_request":
			state.tracked_tools = [
				...state.tracked_tools.filter((tool) => tool.call_id !== msg.call_id),
				{
					call_id: msg.call_id,
					tool: msg.tool,
					args: msg.args,
				},
			];
			if (msg.request_type === "approval") {
				state.pending_approvals = [
					...state.pending_approvals.filter(
						(approval) => approval.call_id !== msg.call_id,
					),
					{
						call_id: msg.call_id,
						tool: msg.tool,
						args: msg.args,
					},
				];
			} else if (msg.request_type === "client_tool") {
				state.pending_client_tools = [
					...state.pending_client_tools.filter(
						(request) => request.call_id !== msg.call_id,
					),
					{
						call_id: msg.call_id,
						tool: msg.tool,
						args: msg.args,
					},
				];
			} else {
				state.pending_user_inputs = [
					...state.pending_user_inputs.filter(
						(request) => request.call_id !== msg.call_id,
					),
					{
						call_id: msg.call_id,
						tool: msg.tool,
						args: msg.args,
					},
				];
			}
			return;
		case "server_request_resolved":
			if (msg.request_type === "approval") {
				state.pending_approvals = state.pending_approvals.filter(
					(approval) => approval.call_id !== msg.call_id,
				);
				if (msg.resolution !== "approved") {
					state.tracked_tools = state.tracked_tools.filter(
						(tool) => tool.call_id !== msg.call_id,
					);
				}
			} else if (msg.request_type === "client_tool") {
				state.pending_client_tools = state.pending_client_tools.filter(
					(request) => request.call_id !== msg.call_id,
				);
				if (msg.resolution === "cancelled") {
					state.tracked_tools = state.tracked_tools.filter(
						(tool) => tool.call_id !== msg.call_id,
					);
				}
			} else {
				state.pending_user_inputs = state.pending_user_inputs.filter(
					(request) => request.call_id !== msg.call_id,
				);
				if (msg.resolution !== "answered") {
					state.tracked_tools = state.tracked_tools.filter(
						(tool) => tool.call_id !== msg.call_id,
					);
				}
			}
			return;
		case "utility_command_started":
			state.active_utility_commands = [
				...state.active_utility_commands.filter(
					(command) => command.command_id !== msg.command_id,
				),
				{
					command_id: msg.command_id,
					command: msg.command,
					cwd: msg.cwd,
					shell_mode: msg.shell_mode,
					terminal_mode: msg.terminal_mode,
					pid: msg.pid,
					columns: msg.columns,
					rows: msg.rows,
					owner_connection_id: msg.owner_connection_id,
					output: "",
				},
			];
			return;
		case "utility_command_resized":
			state.active_utility_commands = state.active_utility_commands.map(
				(command) =>
					command.command_id === msg.command_id
						? {
								...command,
								columns: msg.columns,
								rows: msg.rows,
							}
						: command,
			);
			return;
		case "utility_command_output":
			state.active_utility_commands = state.active_utility_commands.map(
				(command) =>
					command.command_id === msg.command_id
						? {
								...command,
								output: appendHeadlessOutput(command.output, msg.content),
							}
						: command,
			);
			return;
		case "utility_command_exited":
			state.active_utility_commands = state.active_utility_commands.filter(
				(command) => command.command_id !== msg.command_id,
			);
			return;
		case "utility_file_search_results":
			return;
		case "utility_file_watch_started":
			state.active_file_watches = [
				...state.active_file_watches.filter(
					(watch) => watch.watch_id !== msg.watch_id,
				),
				{
					watch_id: msg.watch_id,
					root_dir: msg.root_dir,
					include_patterns: msg.include_patterns,
					exclude_patterns: msg.exclude_patterns,
					debounce_ms: msg.debounce_ms,
					owner_connection_id: msg.owner_connection_id,
				},
			];
			return;
		case "utility_file_watch_event":
			return;
		case "utility_file_watch_stopped":
			state.active_file_watches = state.active_file_watches.filter(
				(watch) => watch.watch_id !== msg.watch_id,
			);
			return;
		case "error":
			state.last_error = msg.message;
			state.last_error_type = msg.error_type;
			return;
		case "status":
			state.last_status = msg.message;
			return;
		case "compaction":
			return;
	}
}

export function buildHeadlessServerRequestCancellationMessages(
	state: Pick<
		HeadlessRuntimeState,
		"pending_approvals" | "pending_client_tools" | "pending_user_inputs"
	>,
	reason: string,
): HeadlessServerRequestResolvedMessage[] {
	return [
		...state.pending_approvals.map((approval) => ({
			type: "server_request_resolved" as const,
			request_id: approval.call_id,
			request_type: "approval" as const,
			call_id: approval.call_id,
			resolution: "cancelled" as const,
			reason,
			resolved_by: "runtime" as const,
		})),
		...state.pending_client_tools.map((request) => ({
			type: "server_request_resolved" as const,
			request_id: request.call_id,
			request_type: "client_tool" as const,
			call_id: request.call_id,
			resolution: "cancelled" as const,
			reason,
			resolved_by: "runtime" as const,
		})),
		...state.pending_user_inputs.map((request) => ({
			type: "server_request_resolved" as const,
			request_id: request.call_id,
			request_type: "user_input" as const,
			call_id: request.call_id,
			resolution: "cancelled" as const,
			reason,
			resolved_by: "runtime" as const,
		})),
	];
}
