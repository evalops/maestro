/**
 * RPC Types for Composer Agent
 *
 * Defines the typed protocol for JSON-over-stdio RPC communication.
 *
 * @module rpc/rpc-types
 */

import type {
	AgentEvent,
	Api,
	AppMessage,
	Message,
	Model,
} from "../agent/types.js";

// ============================================================================
// RPC Commands (Client -> Server)
// ============================================================================

/**
 * Base interface for all RPC commands.
 */
export interface RpcCommandBase {
	type: string;
	/** Optional request ID for response correlation */
	id?: string;
}

/**
 * Send a prompt to the agent.
 */
export interface RpcPromptCommand extends RpcCommandBase {
	type: "prompt";
	/** The message to send */
	message: string;
	/** Optional attachments */
	attachments?: Array<{
		id: string;
		type: "image" | "document";
		fileName: string;
		mimeType: string;
		size: number;
		content: string;
	}>;
}

/**
 * Abort the current agent operation.
 */
export interface RpcAbortCommand extends RpcCommandBase {
	type: "abort";
}

/**
 * Get the current conversation messages.
 */
export interface RpcGetMessagesCommand extends RpcCommandBase {
	type: "get_messages";
}

/**
 * Get the full agent state.
 */
export interface RpcGetStateCommand extends RpcCommandBase {
	type: "get_state";
}

/**
 * Continue the conversation without a new user message.
 */
export interface RpcContinueCommand extends RpcCommandBase {
	type: "continue";
	options?: {
		systemPromptOverride?: string;
	};
}

/**
 * Trigger context compaction.
 */
export interface RpcCompactCommand extends RpcCommandBase {
	type: "compact";
	customInstructions?: string;
}

/**
 * Union of all RPC commands.
 */
export type RpcCommand =
	| RpcPromptCommand
	| RpcAbortCommand
	| RpcGetMessagesCommand
	| RpcGetStateCommand
	| RpcContinueCommand
	| RpcCompactCommand;

// ============================================================================
// RPC Responses (Server -> Client)
// ============================================================================

/**
 * Base interface for all RPC responses.
 */
export interface RpcResponseBase {
	type: string;
	/** Request ID if provided in command */
	id?: string;
}

/**
 * Response containing conversation messages.
 */
export interface RpcMessagesResponse extends RpcResponseBase {
	type: "messages";
	messages: Message[];
}

/**
 * Response containing agent state.
 */
export interface RpcStateResponse extends RpcResponseBase {
	type: "state";
	state: {
		model: Model<Api>;
		messages: Message[];
		isStreaming: boolean;
		error: string | null;
		thinkingLevel: number;
		session?: { id: string };
		queuedMessageCount: number;
	};
}

/**
 * Error response.
 */
export interface RpcErrorResponse extends RpcResponseBase {
	type: "error";
	error: string;
}

/**
 * Compaction event response.
 */
export interface RpcCompactionResponse extends RpcResponseBase {
	type: "compaction";
	summary: string;
	firstKeptEntryIndex: number;
	tokensBefore: number;
	auto: boolean;
	customInstructions?: string;
	timestamp: string;
}

/**
 * Union of all RPC responses.
 */
export type RpcResponse =
	| RpcMessagesResponse
	| RpcStateResponse
	| RpcErrorResponse
	| RpcCompactionResponse
	| AgentEvent;

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Agent event types that can be received over RPC.
 */
export type RpcAgentEventType = AgentEvent["type"];

/**
 * Check if an RPC response is an agent event.
 */
export function isAgentEvent(response: RpcResponse): response is AgentEvent {
	return [
		"message_start",
		"message_update",
		"message_end",
		"agent_start",
		"agent_end",
		"tool_execution_start",
		"tool_execution_update",
		"tool_execution_end",
		"error",
	].includes(response.type);
}

/**
 * Check if an RPC response is an error.
 */
export function isErrorResponse(
	response: RpcResponse,
): response is RpcErrorResponse {
	return response.type === "error";
}
