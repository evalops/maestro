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
 * - { type: "prompt", content: string, attachments?: string[] }
 * - { type: "interrupt" }
 * - { type: "tool_response", call_id: string, approved: boolean, result?: object }
 * - { type: "shutdown" }
 *
 * ## Messages from Agent to TUI (stdout):
 * - { type: "ready", model: string, provider: string }
 * - { type: "response_start", response_id: string }
 * - { type: "response_chunk", response_id: string, content: string, is_thinking: boolean }
 * - { type: "response_end", response_id: string, usage?: object }
 * - { type: "tool_call", call_id: string, tool: string, args: object, requires_approval: boolean }
 * - { type: "tool_start", call_id: string }
 * - { type: "tool_output", call_id: string, content: string }
 * - { type: "tool_end", call_id: string, success: boolean }
 * - { type: "error", message: string, fatal: boolean }
 * - { type: "status", message: string }
 * - { type: "session_info", session_id?: string, cwd: string, git_branch?: string }
 */

import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { lookup as lookupMimeType } from "mime-types";

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

// =============================================================================
// Messages from TUI to Agent
// =============================================================================

interface PromptMessage {
	type: "prompt";
	content: string;
	attachments?: string[];
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
	model: string;
	provider: string;
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
	usage?: {
		input_tokens: number;
		output_tokens: number;
		cache_read_tokens: number;
		cache_write_tokens: number;
		cost?: number;
	};
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

async function loadAttachments(paths: string[]): Promise<Attachment[]> {
	const attachments: Attachment[] = [];

	for (const rawPath of paths) {
		const absolutePath = normalizePath(rawPath);

		try {
			await access(absolutePath, constants.R_OK);
		} catch {
			send({
				type: "error",
				message: `Attachment not readable: ${rawPath}`,
				fatal: false,
			});
			continue;
		}

		let fileStats: Awaited<ReturnType<typeof stat>>;
		try {
			fileStats = await stat(absolutePath);
		} catch {
			send({
				type: "error",
				message: `Attachment not found: ${rawPath}`,
				fatal: false,
			});
			continue;
		}

		if (fileStats.size > MAX_HEADLESS_ATTACHMENT_BYTES) {
			send({
				type: "error",
				message: `Attachment too large (${Math.round(
					fileStats.size / (1024 * 1024),
				)}MB): ${rawPath}`,
				fatal: false,
			});
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
			send({
				type: "error",
				message: `Unsupported attachment (not image/text): ${rawPath}`,
				fatal: false,
			});
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
			send({
				type: "response_chunk",
				response_id: messageId,
				content: event.delta,
				is_thinking: false,
			});
			break;

		case "thinking_delta":
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
			currentMessageId = generateMessageId();
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
			// Extract usage from assistant messages
			let usage: ResponseEndMessage["usage"];
			const msg = event.message;

			if (msg.role === "assistant") {
				const assistantMsg = msg as AssistantMessage;
				if (assistantMsg.usage) {
					usage = {
						input_tokens: assistantMsg.usage.input ?? 0,
						output_tokens: assistantMsg.usage.output ?? 0,
						cache_read_tokens: assistantMsg.usage.cacheRead ?? 0,
						cache_write_tokens: assistantMsg.usage.cacheWrite ?? 0,
						cost: assistantMsg.usage.cost?.total,
					};
				}
			}

			send({
				type: "response_end",
				response_id: currentMessageId,
				usage,
			});
			break;
		}

		case "tool_execution_start":
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
			send({
				type: "error",
				message: event.message,
				fatal: false,
			});
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
): Promise<void> {
	// Subscribe to agent events
	agent.subscribe((event) => {
		handleAgentEvent(event);
	});

	// Send ready message
	const model = agent.state.model;
	send({
		type: "ready",
		model: model.id,
		provider: model.provider,
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
					// Tool approval/rejection is handled via the approval service
					// The headless mode uses auto-approval, so this is mainly for
					// forwarding results back
					// TODO: Implement tool response handling if needed
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
			send({
				type: "error",
				message: `Failed to parse command: ${message}`,
				fatal: false,
			});
		}
	});

	// Keep alive until stdin closes
	return new Promise<void>((resolve) => {
		rl.on("close", () => {
			resolve();
		});
	});
}
