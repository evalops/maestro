/**
 * Headless Agent Mode for Native TUI Communication
 *
 * This module provides a headless operation mode for the Composer agent
 * that communicates via simple JSON-over-stdio with a native Rust TUI.
 *
 * The protocol is simpler than the full RPC mode - it focuses on the
 * essential messages needed for a chat interface:
 *
 * ## Messages from TUI to Agent (stdin):
 * - { type: "init", system_prompt?: string, append_system_prompt?: string, thinking_level?: string, approval_mode?: string }
 * - { type: "prompt", content: string, attachments?: string[] }
 * - { type: "interrupt" }
 * - { type: "tool_response", call_id: string, approved: boolean, result?: object }
 * - { type: "cancel" }
 * - { type: "shutdown" }
 *
 * ## Messages from Agent to TUI (stdout):
 * - { type: "ready", protocol_version: string, model: string, provider: string, session_id?: string }
 * - { type: "response_start", response_id: string }
 * - { type: "response_chunk", response_id: string, content: string, is_thinking: boolean }
 * - { type: "response_end", response_id: string, usage: object, tools_summary: object, duration_ms: number, ttft_ms?: number }
 * - { type: "tool_call", call_id: string, tool: string, args: object, requires_approval: boolean }
 * - { type: "tool_start", call_id: string }
 * - { type: "tool_output", call_id: string, content: string }
 * - { type: "tool_end", call_id: string, success: boolean }
 * - { type: "error", message: string, fatal: boolean, error_type: "transient" | "fatal" | "tool" | "cancelled" | "protocol" }
 * - { type: "status", message: string }
 * - { type: "session_info", session_id?: string, cwd: string, git_branch?: string }
 */

import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { lookup as lookupMimeType } from "mime-types";

import type { ActionApprovalService } from "../agent/action-approval.js";
import type { Agent } from "../agent/index.js";
import type {
	AgentEvent,
	AppMessage,
	AssistantMessage,
	AssistantMessageEvent,
	Attachment,
} from "../agent/types.js";
import type { SessionManager } from "../session/manager.js";
import { isSupportedImageFormat } from "../tools/image-processor.js";
import { getCurrentBranch, isInsideGitRepository } from "../utils/git.js";
import { normalizePath } from "../utils/path-validation.js";
import { summarizeToolUse } from "../utils/tool-use-summary.js";

// =============================================================================
// Messages from TUI to Agent
// =============================================================================

interface PromptMessage {
	type: "prompt";
	content: string;
	attachments?: string[];
}

interface InitMessage {
	type: "init";
	system_prompt?: string;
	append_system_prompt?: string;
	thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "ultra";
	approval_mode?: "auto" | "prompt" | "fail";
}

interface InterruptMessage {
	type: "interrupt";
}

interface ToolResponseMessage {
	type: "tool_response";
	call_id: string;
	approved: boolean;
	result?: {
		success: boolean;
		output: string;
		error?: string;
	};
}

interface CancelMessage {
	type: "cancel";
}

interface ShutdownMessage {
	type: "shutdown";
}

type ToAgentMessage =
	| InitMessage
	| PromptMessage
	| InterruptMessage
	| ToolResponseMessage
	| CancelMessage
	| ShutdownMessage;

// =============================================================================
// Messages from Agent to TUI
// =============================================================================

interface ReadyMessage {
	type: "ready";
	protocol_version: string;
	model: string;
	provider: string;
	session_id: string | null;
}

interface ResponseStartMessage {
	type: "response_start";
	response_id: string;
}

interface ResponseChunkMessage {
	type: "response_chunk";
	response_id: string;
	content: string;
	is_thinking: boolean;
}

interface ResponseEndMessage {
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

interface ToolCallMessage {
	type: "tool_call";
	call_id: string;
	tool: string;
	args: unknown;
	requires_approval: boolean;
}

interface ToolStartMessage {
	type: "tool_start";
	call_id: string;
}

interface ToolOutputMessage {
	type: "tool_output";
	call_id: string;
	content: string;
}

interface ToolEndMessage {
	type: "tool_end";
	call_id: string;
	success: boolean;
}

interface ErrorMessage {
	type: "error";
	message: string;
	fatal: boolean;
	error_type: "transient" | "fatal" | "tool" | "cancelled" | "protocol";
}

interface StatusMessage {
	type: "status";
	message: string;
}

interface SessionInfoMessage {
	type: "session_info";
	session_id: string | null;
	cwd: string;
	git_branch: string | null;
}

type FromAgentMessage =
	| ReadyMessage
	| ResponseStartMessage
	| ResponseChunkMessage
	| ResponseEndMessage
	| ToolCallMessage
	| ToolStartMessage
	| ToolOutputMessage
	| ToolEndMessage
	| ErrorMessage
	| StatusMessage
	| SessionInfoMessage;

// =============================================================================
// Implementation
// =============================================================================

function send(msg: FromAgentMessage): void {
	// Use process.stdout.write directly to bypass any console redirection
	process.stdout.write(`${JSON.stringify(msg)}\n`);
}

// Track message IDs for response correlation
let currentMessageId = "";

/**
 * Generate a simple message ID
 */
function generateMessageId(): string {
	return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const MAX_HEADLESS_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10MB, aligned with read tool
const MAX_TEXT_ATTACHMENT_CHARS = 100_000;
export const HEADLESS_PROTOCOL_VERSION = "2026-03-30";

interface HeadlessResponseTelemetry {
	responseId: string;
	startedAtMs: number;
	firstChunkAtMs?: number;
	toolsUsed: Set<string>;
	toolSummaryLabels: string[];
	callsSucceeded: number;
	callsFailed: number;
}

let currentResponseTelemetry: HeadlessResponseTelemetry | null = null;

export function classifyHeadlessError(
	message: string,
	fatal: boolean,
): ErrorMessage["error_type"] {
	const normalized = message.toLowerCase();
	if (
		normalized.includes("cancel") ||
		normalized.includes("abort") ||
		normalized.includes("interrupted")
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
		normalized.includes("permission denied") ||
		normalized.includes("approval")
	) {
		return "tool";
	}
	if (
		normalized.includes("parse") ||
		normalized.includes("protocol") ||
		normalized.includes("json")
	) {
		return "protocol";
	}
	return fatal ? "fatal" : "tool";
}

function ensureCurrentResponseTelemetry(
	responseId = currentMessageId || generateMessageId(),
): HeadlessResponseTelemetry {
	if (
		currentResponseTelemetry &&
		currentResponseTelemetry.responseId === responseId
	) {
		return currentResponseTelemetry;
	}

	currentResponseTelemetry = {
		responseId,
		startedAtMs: Date.now(),
		toolsUsed: new Set<string>(),
		toolSummaryLabels: [],
		callsSucceeded: 0,
		callsFailed: 0,
	};
	return currentResponseTelemetry;
}

function noteResponseChunk(): void {
	const telemetry = ensureCurrentResponseTelemetry();
	if (!telemetry.firstChunkAtMs) {
		telemetry.firstChunkAtMs = Date.now();
	}
}

function noteToolExecution(
	toolName: string,
	args?: Record<string, unknown>,
	success?: boolean,
): void {
	const telemetry = ensureCurrentResponseTelemetry();
	telemetry.toolsUsed.add(toolName);
	if (args) {
		const summary = summarizeToolUse(toolName, args);
		if (!telemetry.toolSummaryLabels.includes(summary)) {
			telemetry.toolSummaryLabels.push(summary);
		}
	}
	if (success === true) {
		telemetry.callsSucceeded++;
	}
	if (success === false) {
		telemetry.callsFailed++;
	}
}

function emptyUsage(
	model: string,
	provider: string,
): ResponseEndMessage["usage"] {
	return {
		input_tokens: 0,
		output_tokens: 0,
		cache_read_tokens: 0,
		cache_write_tokens: 0,
		total_tokens: 0,
		total_cost_usd: 0,
		model_id: model,
		provider,
	};
}

export function buildHeadlessUsage(
	message: AssistantMessage | undefined,
	model: string,
	provider: string,
): ResponseEndMessage["usage"] {
	if (!message?.usage) {
		return emptyUsage(model, provider);
	}

	const usage = message.usage;
	const totalTokens =
		(usage.input ?? 0) +
		(usage.output ?? 0) +
		(usage.cacheRead ?? 0) +
		(usage.cacheWrite ?? 0);

	return {
		input_tokens: usage.input ?? 0,
		output_tokens: usage.output ?? 0,
		cache_read_tokens: usage.cacheRead ?? 0,
		cache_write_tokens: usage.cacheWrite ?? 0,
		total_tokens: totalTokens,
		total_cost_usd: usage.cost?.total ?? 0,
		model_id: model,
		provider,
	};
}

export function buildHeadlessToolsSummary(params: {
	toolsUsed: Iterable<string>;
	callsSucceeded: number;
	callsFailed: number;
	summaryLabels?: Iterable<string>;
}): ResponseEndMessage["tools_summary"] {
	const summaryLabels = Array.from(params.summaryLabels ?? []).filter(Boolean);
	return {
		tools_used: Array.from(params.toolsUsed).sort(),
		calls_succeeded: params.callsSucceeded,
		calls_failed: params.callsFailed,
		summary_labels: summaryLabels.length > 0 ? summaryLabels : undefined,
	};
}

function buildResponseEndMessage(
	message: AssistantMessage | undefined,
	model: string,
	provider: string,
): ResponseEndMessage {
	const telemetry = ensureCurrentResponseTelemetry();
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

function sendError(message: string, fatal: boolean): void {
	send({
		type: "error",
		message,
		fatal,
		error_type: classifyHeadlessError(message, fatal),
	});
}

function applyInitMessage(
	agent: Agent,
	msg: InitMessage,
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

async function loadAttachments(paths: string[]): Promise<Attachment[]> {
	const attachments: Attachment[] = [];

	for (const rawPath of paths) {
		const absolutePath = normalizePath(rawPath);

		try {
			await access(absolutePath, constants.R_OK);
		} catch {
			sendError(`Attachment not readable: ${rawPath}`, false);
			continue;
		}

		let fileStats: Awaited<ReturnType<typeof stat>>;
		try {
			fileStats = await stat(absolutePath);
		} catch {
			sendError(`Attachment not found: ${rawPath}`, false);
			continue;
		}

		if (fileStats.size > MAX_HEADLESS_ATTACHMENT_BYTES) {
			sendError(
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

		// Attempt to treat as UTF-8 text document.
		const text = buffer.toString("utf-8");
		if (!text || text.includes("\u0000")) {
			sendError(`Unsupported attachment (not image/text): ${rawPath}`, false);
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

/**
 * Get message ID from an AppMessage
 */
function getMessageId(msg: AppMessage): string {
	// AppMessage doesn't have an id field, use role + timestamp as identifier
	return `${msg.role}_${msg.timestamp ?? Date.now()}`;
}

/**
 * Handle assistant message events (streaming updates)
 */
function handleAssistantMessageEvent(
	event: AssistantMessageEvent,
	messageId: string,
): void {
	switch (event.type) {
		case "text_delta":
			noteResponseChunk();
			send({
				type: "response_chunk",
				response_id: messageId,
				content: event.delta,
				is_thinking: false,
			});
			break;

		case "thinking_delta":
			noteResponseChunk();
			send({
				type: "response_chunk",
				response_id: messageId,
				content: event.delta,
				is_thinking: true,
			});
			break;

		// Other events (start, end, toolcall_*) are handled by AgentEvent
		default:
			break;
	}
}

/**
 * Translate agent events to headless protocol messages
 */
function handleAgentEvent(event: AgentEvent): void {
	switch (event.type) {
		case "message_start": {
			if (event.message.role !== "assistant") {
				break;
			}
			currentMessageId = generateMessageId();
			currentResponseTelemetry = {
				responseId: currentMessageId,
				startedAtMs: Date.now(),
				toolsUsed: new Set<string>(),
				toolSummaryLabels: [],
				callsSucceeded: 0,
				callsFailed: 0,
			};
			send({
				type: "response_start",
				response_id: currentMessageId,
			});
			break;
		}

		case "message_update": {
			// Handle streaming text/thinking deltas
			handleAssistantMessageEvent(
				event.assistantMessageEvent,
				currentMessageId,
			);
			break;
		}

		case "message_end": {
			if (event.message.role !== "assistant") {
				break;
			}
			send(
				buildResponseEndMessage(
					event.message as AssistantMessage,
					event.message.model,
					event.message.provider,
				),
			);
			currentResponseTelemetry = null;
			break;
		}

		case "tool_execution_start":
			noteToolExecution(event.toolName, event.args);
			send({
				type: "tool_call",
				call_id: event.toolCallId,
				tool: event.toolName,
				args: event.args,
				requires_approval: false, // Already approved if executing
			});
			send({
				type: "tool_start",
				call_id: event.toolCallId,
			});
			break;

		case "tool_execution_end":
			noteToolExecution(event.toolName, undefined, !event.isError);
			send({
				type: "tool_end",
				call_id: event.toolCallId,
				success: !event.isError,
			});
			break;

		case "action_approval_required":
			// Tool needs approval - send tool_call with requires_approval=true
			send({
				type: "tool_call",
				call_id: event.request.id,
				tool: event.request.toolName,
				args: event.request.args,
				requires_approval: true,
			});
			break;

		case "error":
			sendError(event.message, false);
			break;

		case "status":
			send({
				type: "status",
				message: event.status,
			});
			break;

		// Events we don't forward
		case "agent_start":
		case "agent_end":
		case "turn_start":
		case "turn_end":
		case "action_approval_resolved":
		case "tool_retry_required":
		case "tool_retry_resolved":
		case "client_tool_request":
		case "compaction":
			// Not needed for basic TUI
			break;

		default:
			// Unknown event type - ignore
			break;
	}
}

/**
 * Run the agent in headless mode for native TUI communication.
 *
 * This mode:
 * 1. Sends a "ready" message with model info
 * 2. Sends session info
 * 3. Reads JSON commands from stdin
 * 4. Writes JSON events to stdout
 * 5. Runs until shutdown or stdin closes
 */
export async function runHeadlessMode(
	agent: Agent,
	sessionManager: SessionManager,
	approvalService?: ActionApprovalService,
): Promise<void> {
	// Subscribe to agent events
	agent.subscribe((event) => {
		handleAgentEvent(event);
	});

	// Send ready message
	const model = agent.state.model;
	send({
		type: "ready",
		protocol_version: HEADLESS_PROTOCOL_VERSION,
		model: model.id,
		provider: model.provider,
		session_id: sessionManager.getSessionId() ?? null,
	});

	// Send session info
	const cwd = process.cwd();
	const gitBranch = isInsideGitRepository()
		? (getCurrentBranch() ?? null)
		: null;
	send({
		type: "session_info",
		session_id: sessionManager.getSessionId() ?? null,
		cwd,
		git_branch: gitBranch,
	});

	// Set up stdin reading
	const readline = await import("node:readline");
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: false,
	});

	// Handle incoming commands
	rl.on("line", async (line: string) => {
		try {
			const msg = JSON.parse(line) as ToAgentMessage;

			switch (msg.type) {
				case "init": {
					const applied = applyInitMessage(agent, msg, approvalService);
					send({
						type: "status",
						message:
							applied.length > 0
								? `Initialized: ${applied.join(", ")}`
								: "Init received with no changes",
					});
					break;
				}

				case "prompt":
					if (msg.attachments && msg.attachments.length > 0) {
						const loaded = await loadAttachments(msg.attachments);
						if (loaded.length > 0) {
							send({
								type: "status",
								message: `Loaded ${loaded.length} attachment(s)`,
							});
							await agent.prompt(msg.content, loaded);
						} else {
							await agent.prompt(msg.content);
						}
					} else {
						await agent.prompt(msg.content);
					}
					break;

				case "interrupt":
					agent.abort();
					break;

				case "tool_response":
					// Handle tool approval/rejection from the TUI
					if (approvalService) {
						if (msg.approved) {
							const resolved = approvalService.approve(msg.call_id);
							if (!resolved) {
								sendError(
									`No pending approval found for call_id: ${msg.call_id}`,
									false,
								);
							}
						} else {
							const reason = msg.result?.error ?? "Denied by user";
							const resolved = approvalService.deny(msg.call_id, reason);
							if (!resolved) {
								sendError(
									`No pending approval found for call_id: ${msg.call_id}`,
									false,
								);
							}
						}
					} else {
						// No approval service - headless mode is using auto-approval
						send({
							type: "status",
							message: "Tool response ignored (auto-approval mode)",
						});
					}
					break;

				case "cancel":
					agent.abort();
					break;

				case "shutdown":
					process.exit(0);
					break;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendError(`Failed to parse command: ${message}`, false);
		}
	});

	// Keep alive until stdin closes
	return new Promise<void>((resolve) => {
		rl.on("close", () => {
			resolve();
		});
	});
}
