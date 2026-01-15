/**
 * @fileoverview Core Type Definitions for Composer Agent
 *
 * This module defines the fundamental types used throughout the Composer AI system,
 * including message formats, tool definitions, model configurations, and agent state.
 *
 * ## Type Categories
 *
 * ### Message Types
 * - {@link UserMessage} - Messages from the human user
 * - {@link AssistantMessage} - Responses from the AI assistant
 * - {@link ToolResultMessage} - Results from tool executions
 * - {@link Message} - Union of all message types
 *
 * ### Content Types
 * - {@link TextContent} - Plain text content blocks
 * - {@link ImageContent} - Base64-encoded images
 * - {@link ThinkingContent} - Extended reasoning traces
 * - {@link ToolCall} - Tool invocation requests
 *
 * ### Tool Types
 * - {@link Tool} - Tool definition schema (for API)
 * - {@link AgentTool} - Tool with execute function (for runtime)
 * - {@link AgentToolResult} - Return value from tool execution
 *
 * ### Configuration Types
 * - {@link Model} - LLM model configuration
 * - {@link AgentState} - Current state of an agent
 * - {@link AgentRunConfig} - Runtime configuration
 *
 * @module agent/types
 */

import type { TSchema } from "@sinclair/typebox";
import type {
	ActionApprovalDecision,
	ActionApprovalRequest,
} from "./action-approval.js";

/**
 * API format identifier for different LLM provider APIs.
 *
 * Each provider may support different API formats:
 * - `openai-completions` - OpenAI Chat Completions API
 * - `openai-responses` - OpenAI Responses API (newer format)
 * - `anthropic-messages` - Anthropic Messages API
 * - `google-generative-ai` - Google Generative AI (Gemini)
 * - `google-gemini-cli` - Google Cloud Code Assist (Gemini CLI)
 * - `bedrock-converse` - AWS Bedrock Converse API
 */
export type Api =
	| "openai-completions"
	| "openai-responses"
	| "anthropic-messages"
	| "google-generative-ai"
	| "google-gemini-cli"
	| "bedrock-converse"
	| "vertex-ai";

export interface OpenAICompatOverrides {
	supportsStore?: boolean;
	supportsDeveloperRole?: boolean;
	supportsReasoningEffort?: boolean;
	supportsResponsesApi?: boolean;
	/** Supports Anthropic-style cache_control (OpenRouter with Claude models) */
	supportsCacheControl?: boolean;
	maxTokensField?: "max_tokens" | "max_completion_tokens";
	requiresToolResultName?: boolean;
	requiresAssistantAfterToolResult?: boolean;
	requiresThinkingAsText?: boolean;
	requiresMistralToolIds?: boolean;
}

/**
 * Well-known LLM provider identifiers.
 *
 * These are the officially supported providers with built-in configurations:
 * - `anthropic` - Anthropic (Claude models)
 * - `bedrock` - AWS Bedrock
 * - `google` - Google AI (Gemini models)
 * - `openai` - OpenAI (GPT models)
 * - `azure-openai` - Azure OpenAI
 * - `writer` - Writer.com
 * - `xai` - xAI (Grok models)
 * - `groq` - Groq
 * - `cerebras` - Cerebras
 * - `openrouter` - OpenRouter (aggregator)
 * - `zai` - ZAI
 */
export type KnownProvider =
	| "anthropic"
	| "bedrock"
	| "google"
	| "openai"
	| "azure-openai"
	| "writer"
	| "xai"
	| "groq"
	| "cerebras"
	| "openrouter"
	| "zai";

/**
 * Provider identifier - either a known provider or a custom string.
 * Custom providers can be used with OpenAI-compatible APIs.
 */
export type Provider = KnownProvider | string;

/**
 * Reasoning effort level for models that support extended thinking.
 *
 * Higher levels produce more detailed reasoning at increased latency:
 * - `minimal` - Brief chain-of-thought hints
 * - `low` - Short reasoning steps
 * - `medium` - Moderate reasoning depth (recommended default)
 * - `high` - Thorough step-by-step reasoning
 * - `ultra` - Maximum reasoning depth (for complex problems)
 *
 * Note: Claude Code uses keywords "think", "think hard", "think harder", "ultrathink"
 * which map to low, medium, high, ultra respectively.
 */
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "ultra";

/**
 * Plain text content block within a message.
 *
 * @example
 * ```typescript
 * const content: TextContent = {
 *   type: "text",
 *   text: "Hello, how can I help you today?"
 * };
 * ```
 */
export interface TextContent {
	/** Discriminator for content block type */
	type: "text";
	/** The text content */
	text: string;
	/** Optional signature for content verification */
	textSignature?: string;
}

/**
 * Extended thinking/reasoning content block.
 *
 * Contains the model's internal reasoning process when extended
 * thinking is enabled. This is typically hidden from end users
 * but useful for debugging and understanding model behavior.
 */
export interface ThinkingContent {
	/** Discriminator for content block type */
	type: "thinking";
	/** The thinking/reasoning trace */
	thinking: string;
	/** Optional signature for content verification */
	thinkingSignature?: string;
}

/**
 * Base64-encoded image content block.
 *
 * Used for including images in user messages (vision input)
 * or tool results (screenshots, generated images).
 *
 * @example
 * ```typescript
 * const image: ImageContent = {
 *   type: "image",
 *   data: "iVBORw0KGgo...", // base64 encoded
 *   mimeType: "image/png"
 * };
 * ```
 */
export interface ImageContent {
	/** Discriminator for content block type */
	type: "image";
	/** Base64-encoded image data */
	data: string;
	/** MIME type (e.g., "image/png", "image/jpeg") */
	mimeType: string;
}

/**
 * Tool invocation request within an assistant message.
 *
 * When the model decides to use a tool, it emits a ToolCall
 * content block specifying which tool to call and with what arguments.
 *
 * @example
 * ```typescript
 * const toolCall: ToolCall = {
 *   type: "toolCall",
 *   id: "call_abc123",
 *   name: "read",
 *   arguments: { file_path: "/src/index.ts" }
 * };
 * ```
 */
export interface ToolCall {
	/** Discriminator for content block type */
	type: "toolCall";
	/** Unique identifier for this tool call (used to match results) */
	id: string;
	/** Name of the tool to invoke */
	name: string;
	/** Arguments to pass to the tool */
	arguments: Record<string, unknown>;
	/**
	 * Provider-specific signature used by some APIs (notably Gemini 3) to
	 * associate tool calls with preceding thoughts. If present, it must be
	 * preserved across turns when replaying the message history back to the provider.
	 */
	thoughtSignature?: string;
}

/**
 * Token usage and cost information for a message or request.
 *
 * Tracks input/output tokens and cache utilization for cost monitoring
 * and context window management.
 */
export interface Usage {
	/** Number of input tokens consumed */
	input: number;
	/** Number of output tokens generated */
	output: number;
	/** Tokens served from prompt cache (reduces cost) */
	cacheRead: number;
	/** Tokens written to prompt cache */
	cacheWrite: number;
	/** Calculated cost breakdown in USD */
	cost: {
		/** Cost for input tokens */
		input: number;
		/** Cost for output tokens */
		output: number;
		/** Cost savings from cache reads */
		cacheRead: number;
		/** Cost for cache writes */
		cacheWrite: number;
		/** Total cost for this message/request */
		total: number;
	};
}

/**
 * Reason why the model stopped generating.
 *
 * - `stop` - Natural completion (end of response)
 * - `length` - Hit max_tokens limit
 * - `toolUse` - Model wants to use a tool (generation paused)
 * - `error` - An error occurred during generation
 * - `aborted` - Request was cancelled by the user
 */
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

/**
 * Message from the human user.
 *
 * User messages can contain plain text or an array of content blocks
 * (for multi-modal input with images).
 *
 * @example
 * ```typescript
 * // Simple text message
 * const msg: UserMessage = {
 *   role: "user",
 *   content: "What is this code doing?",
 *   timestamp: Date.now()
 * };
 *
 * // Message with image
 * const multiModal: UserMessage = {
 *   role: "user",
 *   content: [
 *     { type: "text", text: "What's in this screenshot?" },
 *     { type: "image", data: base64Data, mimeType: "image/png" }
 *   ],
 *   timestamp: Date.now()
 * };
 * ```
 */
export interface UserMessage {
	/** Message role discriminator */
	role: "user";
	/** Message content - string or array of content blocks */
	content: string | (TextContent | ImageContent)[];
	/** Unix timestamp in milliseconds when message was created */
	timestamp: number;
}

/**
 * Response message from the AI assistant.
 *
 * Contains the model's response along with metadata about the generation
 * including token usage, stop reason, and provider information.
 *
 * The content array may contain:
 * - {@link TextContent} - The actual response text
 * - {@link ThinkingContent} - Extended reasoning (if enabled)
 * - {@link ToolCall} - Tool invocation requests
 */
export interface AssistantMessage {
	/** Message role discriminator */
	role: "assistant";
	/** Array of content blocks (text, thinking, tool calls) */
	content: (TextContent | ThinkingContent | ToolCall)[];
	/** API format used for this response */
	api: Api;
	/** Provider that generated this response */
	provider: Provider;
	/** Model ID that generated this response */
	model: string;
	/** Token usage and cost information */
	usage: Usage;
	/** Reason why generation stopped */
	stopReason: StopReason;
	/** Error message if stopReason is "error" */
	errorMessage?: string;
	/** Unix timestamp in milliseconds when message was created */
	timestamp: number;
}

/**
 * Result message from a tool execution.
 *
 * After a tool is executed, the result is sent back to the model
 * as a ToolResultMessage so it can incorporate the information
 * into its response.
 *
 * @typeParam TDetails - Type of additional details attached to the result
 *
 * @example
 * ```typescript
 * const result: ToolResultMessage = {
 *   role: "toolResult",
 *   toolCallId: "call_abc123",
 *   toolName: "read",
 *   content: [{ type: "text", text: "file contents..." }],
 *   isError: false,
 *   timestamp: Date.now()
 * };
 * ```
 */
export interface ToolResultMessage<TDetails = unknown> {
	/** Message role discriminator */
	role: "toolResult";
	/** ID of the tool call this result corresponds to */
	toolCallId: string;
	/** Name of the tool that was executed */
	toolName: string;
	/** Result content (text or images) */
	content: (TextContent | ImageContent)[];
	/** Optional additional details about the execution */
	details?: TDetails;
	/** Whether the tool execution resulted in an error */
	isError: boolean;
	/** Unix timestamp in milliseconds when result was created */
	timestamp: number;
}

/**
 * Message type for hook-injected messages.
 *
 * Hooks can inject these into the conversation. They are converted to user
 * messages for LLM context and can optionally be hidden from the UI.
 */
export interface HookMessage<T = unknown> {
	/** Message role discriminator */
	role: "hookMessage";
	/** Hook-defined message category */
	customType: string;
	/** Message content - string or array of content blocks */
	content: string | (TextContent | ImageContent)[];
	/** Whether to render this message in the UI */
	display: boolean;
	/** Optional hook-specific metadata (not sent to the LLM) */
	details?: T;
	/** Unix timestamp in milliseconds when message was created */
	timestamp: number;
}

/**
 * Message type for branch summaries when navigating session trees.
 */
export interface BranchSummaryMessage {
	/** Message role discriminator */
	role: "branchSummary";
	/** Summary text */
	summary: string;
	/** ID of the branch point this summary came from */
	fromId: string;
	/** Unix timestamp in milliseconds when summary was created */
	timestamp: number;
}

/**
 * Message type for compaction summaries.
 */
export interface CompactionSummaryMessage {
	/** Message role discriminator */
	role: "compactionSummary";
	/** Summary text */
	summary: string;
	/** Token count before compaction (for diagnostics) */
	tokensBefore: number;
	/** Unix timestamp in milliseconds when summary was created */
	timestamp: number;
}

/**
 * Union type representing any message in a conversation.
 *
 * A conversation is an ordered sequence of messages alternating between
 * user input, assistant responses, and tool results.
 */
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

/**
 * Tool definition schema for API serialization.
 *
 * This interface defines a tool's metadata and parameter schema
 * for transmission to the LLM. The actual execution logic is in
 * {@link AgentTool}.
 *
 * @typeParam TParameters - TypeBox schema for the tool's parameters
 *
 * @example
 * ```typescript
 * import { Type } from "@sinclair/typebox";
 *
 * const readTool: Tool = {
 *   name: "read",
 *   description: "Read a file from the filesystem",
 *   parameters: Type.Object({
 *     file_path: Type.String({ description: "Path to the file" })
 *   })
 * };
 * ```
 */
export interface Tool<TParameters extends TSchema = TSchema> {
	/** Unique tool identifier */
	name: string;
	/** Human-readable description of what the tool does */
	description: string;
	/** TypeBox schema defining the tool's parameters */
	parameters: TParameters;
	/** Optional categorization (e.g., "file", "shell", "web") */
	toolType?: string;
	/** Example inputs for documentation/few-shot prompting */
	inputExamples?: unknown[];
	/** List of caller identifiers allowed to use this tool */
	allowedCallers?: string[];
	/** If true, don't send tool definition to API (used for internal tools) */
	deferApiDefinition?: boolean;
}

/**
 * Behavioral hints for tools (from MCP annotations).
 *
 * These hints help the model and UI understand the tool's behavior
 * for better decision-making and user feedback.
 */
export interface ToolAnnotations {
	/** If true, the tool does not modify its environment (safe to retry) */
	readOnlyHint?: boolean;
	/** If true, the tool may perform destructive/irreversible updates */
	destructiveHint?: boolean;
	/** If true, calling repeatedly with same args has no additional effect */
	idempotentHint?: boolean;
	/** If true, the tool interacts with external systems (network, APIs) */
	openWorldHint?: boolean;
}

/**
 * Complete tool definition with execute function.
 *
 * This is the runtime representation of a tool, including both
 * the schema (for the LLM) and the execute function (for the runtime).
 *
 * @typeParam TParameters - TypeBox schema for the tool's parameters
 * @typeParam TDetails - Type of additional details returned with results
 *
 * @example
 * ```typescript
 * import { Type } from "@sinclair/typebox";
 *
 * const readTool: AgentTool = {
 *   name: "read",
 *   description: "Read a file from the filesystem",
 *   parameters: Type.Object({
 *     file_path: Type.String()
 *   }),
 *   execute: async (toolCallId, params) => {
 *     const content = await fs.readFile(params.file_path, "utf-8");
 *     return { content: [{ type: "text", text: content }] };
 *   }
 * };
 * ```
 */
export interface AgentTool<
	TParameters extends TSchema = TSchema,
	TDetails = unknown,
> {
	/** Unique tool identifier */
	name: string;
	/** Display label for UI (defaults to name) */
	label?: string;
	/** Human-readable description of what the tool does */
	description: string;
	/** TypeBox schema defining the tool's parameters */
	parameters: TParameters;
	/** Tool behavior hints from MCP annotations */
	annotations?: ToolAnnotations;
	/** Optional categorization (e.g., "file", "shell", "web") */
	toolType?: string;
	/**
	 * Where the tool should be executed.
	 * - `"server"`: (default) Executed by the backend agent
	 * - `"client"`: Executed by the client (VS Code, browser) via callback
	 */
	executionLocation?: "server" | "client";
	/** Example inputs for documentation/few-shot prompting */
	inputExamples?: unknown[];
	/** List of caller identifiers allowed to use this tool */
	allowedCallers?: string[];
	/** If true, don't send tool definition to API */
	deferApiDefinition?: boolean;
	/**
	 * Execute the tool with the given parameters.
	 *
	 * @param toolCallId - Unique identifier for this tool call
	 * @param params - Parameters matching the tool's schema
	 * @param signal - Optional AbortSignal for cancellation
	 * @param context - Optional execution context (sandbox, etc.)
	 * @param onUpdate - Optional callback for partial tool output streaming
	 * @returns Tool result with content and optional details
	 */
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		context?: { sandbox?: import("../sandbox/types.js").Sandbox },
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => AgentToolResult<TDetails> | Promise<AgentToolResult<TDetails>>;
}

export type AgentToolUpdateCallback<TDetails = unknown> = (
	partial: AgentToolResult<TDetails>,
) => void;

/**
 * Result returned from tool execution.
 *
 * @typeParam TDetails - Type of additional details attached to the result
 */
export interface AgentToolResult<TDetails = unknown> {
	/** Result content (text or images) */
	content: (TextContent | ImageContent)[];
	/** Optional additional details about the execution */
	details?: TDetails;
	/** Whether the execution resulted in an error */
	isError?: boolean;
}

/**
 * Conversation context for LLM requests.
 *
 * Contains the system prompt, conversation history, and available tools
 * for a single LLM request.
 */
export interface Context {
	/** System prompt providing instructions and context */
	systemPrompt?: string;
	/** Conversation history */
	messages: Message[];
	/** Tools available for the model to use */
	tools?: Tool[];
}

/**
 * Streaming events during assistant message construction.
 *
 * These events are emitted as the LLM generates its response, enabling
 * real-time UI updates and progress tracking.
 *
 * ## Event Types
 *
 * | Type | Description |
 * |------|-------------|
 * | `start` | Message generation started |
 * | `text_start` | New text content block started |
 * | `text_delta` | Incremental text content |
 * | `text_end` | Text content block completed |
 * | `thinking_start` | Extended thinking block started |
 * | `thinking_delta` | Incremental thinking content |
 * | `thinking_end` | Thinking block completed |
 * | `toolcall_start` | Tool call started |
 * | `toolcall_delta` | Incremental tool call args |
 * | `toolcall_end` | Tool call completed |
 * | `done` | Generation completed successfully |
 * | `error` | Generation failed or was aborted |
 */
export type AssistantMessageEvent =
	| {
			/** Message generation started */
			type: "start";
			/** Partial message state */
			partial: AssistantMessage;
	  }
	| {
			/** New text content block started */
			type: "text_start";
			/** Index of the content block */
			contentIndex: number;
			/** Partial message state */
			partial: AssistantMessage;
	  }
	| {
			/** Incremental text content received */
			type: "text_delta";
			/** Index of the content block */
			contentIndex: number;
			/** New text to append */
			delta: string;
			/** Partial message state */
			partial: AssistantMessage;
	  }
	| {
			/** Text content block completed */
			type: "text_end";
			/** Index of the content block */
			contentIndex: number;
			/** Final text content */
			content: string;
			/** Partial message state */
			partial: AssistantMessage;
	  }
	| {
			/** Extended thinking block started */
			type: "thinking_start";
			/** Index of the content block */
			contentIndex: number;
			/** Partial message state */
			partial: AssistantMessage;
	  }
	| {
			/** Incremental thinking content received */
			type: "thinking_delta";
			/** Index of the content block */
			contentIndex: number;
			/** New thinking text to append */
			delta: string;
			/** Partial message state */
			partial: AssistantMessage;
	  }
	| {
			/** Thinking content block completed */
			type: "thinking_end";
			/** Index of the content block */
			contentIndex: number;
			/** Final thinking content */
			content: string;
			/** Partial message state */
			partial: AssistantMessage;
	  }
	| {
			/** Tool call started */
			type: "toolcall_start";
			/** Index of the content block */
			contentIndex: number;
			/** Partial message state */
			partial: AssistantMessage;
	  }
	| {
			/** Incremental tool call arguments received */
			type: "toolcall_delta";
			/** Index of the content block */
			contentIndex: number;
			/** New JSON fragment to append to arguments */
			delta: string;
			/** Partial message state */
			partial: AssistantMessage;
	  }
	| {
			/** Tool call completed */
			type: "toolcall_end";
			/** Index of the content block */
			contentIndex: number;
			/** Completed tool call */
			toolCall: ToolCall;
			/** Partial message state */
			partial: AssistantMessage;
	  }
	| {
			/** Generation completed successfully */
			type: "done";
			/** Reason for completion */
			reason: Extract<StopReason, "stop" | "length" | "toolUse">;
			/** Final assistant message */
			message: AssistantMessage;
	  }
	| {
			/** Generation failed or was aborted */
			type: "error";
			/** Reason for failure */
			reason: Extract<StopReason, "aborted" | "error">;
			/** Error message details */
			error: AssistantMessage;
	  };

/**
 * LLM model configuration.
 *
 * Contains all the information needed to use a model, including
 * API endpoints, capabilities, and pricing.
 *
 * @typeParam TApi - The API format this model uses
 *
 * @example
 * ```typescript
 * const claude: Model<"anthropic-messages"> = {
 *   id: "claude-sonnet-4-5-20250929",
 *   name: "Claude Sonnet 4.5",
 *   api: "anthropic-messages",
 *   provider: "anthropic",
 *   baseUrl: "https://api.anthropic.com/v1",
 *   reasoning: true,
 *   input: ["text", "image"],
 *   cost: { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
 *   contextWindow: 200000,
 *   maxTokens: 8192
 * };
 * ```
 */
export interface Model<TApi extends Api> {
	/** Unique model identifier (e.g., "claude-sonnet-4-5-20250929") */
	id: string;
	/** Human-readable model name (e.g., "Claude Sonnet 4.5") */
	name: string;
	/** API format used for requests */
	api: TApi;
	/** Provider serving this model */
	provider: Provider;
	/** Base URL for API requests */
	baseUrl: string;
	/** Optional custom headers to include in API requests */
	headers?: Record<string, string>;
	/** Optional OpenAI-compatibility overrides for vendor quirks */
	compat?: OpenAICompatOverrides;
	/** Whether the model supports extended thinking */
	reasoning: boolean;
	/** Whether the model supports tool use */
	toolUse?: boolean;
	/** Supported input modalities */
	input: ("text" | "image")[];
	/** Cost per million tokens in USD */
	cost: {
		/** Input token cost */
		input: number;
		/** Output token cost */
		output: number;
		/** Cache read cost (typically discounted) */
		cacheRead: number;
		/** Cache write cost */
		cacheWrite: number;
	};
	/** Maximum context window in tokens */
	contextWindow: number;
	/** Maximum output tokens per response */
	maxTokens: number;
}

/**
 * File attachment for messages.
 *
 * Represents an uploaded file (image or document) that can be
 * included in a user message.
 */
export interface Attachment {
	/** Unique identifier for this attachment */
	id: string;
	/** Type of attachment */
	type: "image" | "document";
	/** Original filename */
	fileName: string;
	/** MIME type of the file */
	mimeType: string;
	/** File size in bytes */
	size: number;
	/** Base64-encoded file content */
	content: string;
	/** Extracted text content (for documents) */
	extractedText?: string;
	/** Preview image (for documents) */
	preview?: string;
}

/**
 * User-configurable thinking level for extended reasoning.
 *
 * Controls how much computational effort the model spends on
 * reasoning before generating a response.
 *
 * - `off` - No extended thinking
 * - `minimal` - Brief reasoning hints
 * - `low` - Short reasoning steps
 * - `medium` - Moderate reasoning (default)
 * - `high` - Thorough step-by-step reasoning
 * - `max` - Maximum reasoning depth
 */
export type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "ultra"
	| "max";

/**
 * User message with optional file attachments.
 *
 * Extends the base UserMessage to support file attachments
 * for rich multi-modal interactions.
 */
export type UserMessageWithAttachments = UserMessage & {
	/** Optional file attachments */
	attachments?: Attachment[];
};

/**
 * Placeholder for custom message types.
 * Can be extended to add application-specific message types.
 */
export interface CustomMessages {
	hookMessage: HookMessage;
	branchSummary: BranchSummaryMessage;
	compactionSummary: CompactionSummaryMessage;
}

/**
 * Application-level message type.
 *
 * Union of all message types that can appear in the UI,
 * including user messages with attachments.
 */
export type AppMessage =
	| AssistantMessage
	| UserMessageWithAttachments
	| Message
	| CustomMessages[keyof CustomMessages];

/**
 * Information about a tool call currently being executed.
 */
export interface PendingToolCall {
	/** Name of the tool being executed */
	toolName: string;
}

/**
 * Current state of an agent instance.
 *
 * This is the central state object managed by the Agent class,
 * containing all information about the current conversation,
 * configuration, and execution status.
 */
export interface AgentState {
	/** System prompt providing instructions and context */
	systemPrompt: string;
	/** Current model configuration */
	model: Model<Api>;
	/** Current thinking level for extended reasoning */
	thinkingLevel: ThinkingLevel;
	/** Optional reasoning summary preference for Responses API */
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	/** Available tools for this agent */
	tools: AgentTool[];
	/**
	 * Controls how queued steering messages are sent between turns.
	 * - `"all"` - Send all queued messages at once
	 * - `"one"` - Send one message at a time
	 */
	steeringMode: "all" | "one";
	/**
	 * Controls how queued follow-up messages are sent between turns.
	 * - `"all"` - Send all queued messages at once
	 * - `"one"` - Send one message at a time
	 */
	followUpMode: "all" | "one";
	/**
	 * @deprecated Use steeringMode/followUpMode instead.
	 */
	queueMode: "all" | "one";
	/** Conversation history */
	messages: AppMessage[];
	/** Whether the agent is currently streaming a response */
	isStreaming: boolean;
	/** Current streaming message (partial response) */
	streamMessage: Message | null;
	/** Tool calls currently being executed */
	pendingToolCalls: Map<string, PendingToolCall>;
	/** Current error message, if any */
	error?: string;
	/** Optional sandbox for isolated tool execution */
	sandbox?: import("../sandbox/types.js").Sandbox;
	/** Current sandbox mode (e.g., "docker", "local") */
	sandboxMode?: string | null;
	/** Whether sandboxing is enabled */
	sandboxEnabled?: boolean;
	/** User identification for tracking */
	user?: {
		/** User UUID */
		id: string;
		/** Organization UUID */
		orgId: string;
	};
	/** Session information for persistence */
	session?: {
		/** Session UUID */
		id: string;
		/** When the session started */
		startedAt: Date;
	};
	/** Sampling temperature override (0.0-2.0, lower = more deterministic) */
	temperature?: number;
	/** Top-p sampling override (0.0-1.0) */
	topP?: number;
}

/**
 * Events emitted during agent execution.
 *
 * These events provide real-time updates about agent activity,
 * enabling UI updates, logging, and progress tracking.
 *
 * ## Lifecycle Events
 * - `agent_start` - Agent execution started
 * - `agent_end` - Agent execution completed
 * - `turn_start` - New conversation turn started
 * - `turn_end` - Conversation turn completed
 *
 * ## Message Events
 * - `message_start` - New message being constructed
 * - `message_update` - Incremental message update
 * - `message_end` - Message completed
 *
 * ## Tool Events
 * - `tool_execution_start` - Tool execution started
 * - `tool_execution_update` - Tool execution produced partial output
 * - `tool_execution_end` - Tool execution completed
 * - `client_tool_request` - Client-side tool invocation needed
 *
 * ## Approval Events
 * - `action_approval_required` - User approval needed
 * - `action_approval_resolved` - User made approval decision
 *
 * ## Status Events
 * - `status` - Status update
 * - `error` - Error occurred
 * - `compaction` - Context was compacted
 */
export type AgentEvent =
	| {
			/** Agent execution started */
			type: "agent_start";
	  }
	| {
			/** Agent execution completed */
			type: "agent_end";
			/** Final messages from this execution */
			messages: AppMessage[];
			/** Whether execution was aborted */
			aborted?: boolean;
			/** If aborted with partial acceptance, contains the saved partial message */
			partialAccepted?: AppMessage;
			/** Final stop reason from the LLM - "length" indicates context overflow */
			stopReason?: StopReason;
	  }
	| {
			/** Status update during execution */
			type: "status";
			/** Status message */
			status: string;
			/** Additional details */
			details: Record<string, unknown>;
	  }
	| {
			/** Error occurred during execution */
			type: "error";
			/** Error message */
			message: string;
	  }
	| {
			/** New conversation turn started */
			type: "turn_start";
	  }
	| {
			/** Conversation turn completed */
			type: "turn_end";
			/** Assistant message from this turn */
			message: AppMessage;
			/** Tool results from this turn */
			toolResults: AppMessage[];
	  }
	| {
			/** New message being constructed */
			type: "message_start";
			/** The message being built */
			message: AppMessage;
	  }
	| {
			/** Incremental update to current message */
			type: "message_update";
			/** Updated message state */
			message: AppMessage;
			/** The streaming event that triggered this update */
			assistantMessageEvent: AssistantMessageEvent;
	  }
	| {
			/** Message completed */
			type: "message_end";
			/** Final message */
			message: AppMessage;
	  }
	| {
			/** Tool execution started */
			type: "tool_execution_start";
			/** Tool call identifier */
			toolCallId: string;
			/** Name of the tool */
			toolName: string;
			/** Arguments passed to the tool */
			args: Record<string, unknown>;
	  }
	| {
			/** Tool execution completed */
			type: "tool_execution_end";
			/** Tool call identifier */
			toolCallId: string;
			/** Name of the tool */
			toolName: string;
			/** Result from the tool */
			result: ToolResultMessage;
			/** Whether the tool returned an error */
			isError: boolean;
	  }
	| {
			/** Tool execution produced partial output */
			type: "tool_execution_update";
			/** Tool call identifier */
			toolCallId: string;
			/** Name of the tool */
			toolName: string;
			/** Arguments passed to the tool */
			args: Record<string, unknown>;
			/** Partial tool result */
			partialResult: AgentToolResult;
	  }
	| {
			/** User approval required for an action */
			type: "action_approval_required";
			/** Details of the approval request */
			request: ActionApprovalRequest;
	  }
	| {
			/** User made approval decision */
			type: "action_approval_resolved";
			/** The original request */
			request: ActionApprovalRequest;
			/** User's decision */
			decision: ActionApprovalDecision;
	  }
	| {
			/** Client-side tool invocation needed */
			type: "client_tool_request";
			/** Tool call identifier */
			toolCallId: string;
			/** Name of the tool */
			toolName: string;
			/** Arguments for the tool */
			args: unknown;
	  }
	| {
			/** Context was compacted (older messages summarized) */
			type: "compaction";
			/** Generated summary of compacted messages */
			summary: string;
			/** Index of first entry to keep (entries before were summarized) */
			firstKeptEntryIndex: number;
			/** Token count before compaction */
			tokensBefore: number;
			/** Whether this was auto-triggered vs manual /compact */
			auto?: boolean;
			/** Custom instructions used for summarization */
			customInstructions?: string;
			/** Timestamp of compaction */
			timestamp: string;
	  }
	| {
			/** Auto-retry started for transient error (rate limit, overload, 5xx) */
			type: "auto_retry_start";
			/** Current retry attempt (1-based) */
			attempt: number;
			/** Maximum number of retry attempts */
			maxAttempts: number;
			/** Delay in milliseconds before retry */
			delayMs: number;
			/** The error message that triggered the retry */
			errorMessage: string;
	  }
	| {
			/** Auto-retry completed (success or final failure) */
			type: "auto_retry_end";
			/** Whether the retry eventually succeeded */
			success: boolean;
			/** Final attempt number */
			attempt: number;
			/** If failed, the final error message */
			finalError?: string;
	  };

/**
 * Message queued for sending to the LLM.
 *
 * Wraps the original message with an optional LLM-formatted version,
 * allowing for message transformation before sending.
 *
 * @typeParam TOriginal - Type of the original message
 */
export interface QueuedMessage<TOriginal = AppMessage> {
	/** Original message as received */
	original: TOriginal;
	/** Optional LLM-formatted version of the message */
	llm?: Message;
}

/**
 * Runtime configuration for agent execution.
 *
 * Passed to the transport layer when starting a new agent run,
 * containing all the configuration needed to execute a conversation turn.
 */
export interface AgentRunConfig {
	/** System prompt providing instructions and context */
	systemPrompt: string;
	/** Tools available for this run */
	tools: AgentTool[];
	/** Model to use for generation */
	model: Model<Api>;
	/** Optional reasoning effort level */
	reasoning?: ReasoningEffort;
	/** Optional reasoning summary preference for Responses API */
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	/** Function to retrieve steering messages for batch sending */
	getSteeringMessages?: <T>() => Promise<QueuedMessage<T>[]>;
	/** Function to retrieve follow-up messages for batch sending */
	getFollowUpMessages?: <T>() => Promise<QueuedMessage<T>[]>;
	/** @deprecated Use getSteeringMessages/getFollowUpMessages instead */
	getQueuedMessages?: <T>() => Promise<QueuedMessage<T>[]>;
	/**
	 * Optional message preprocessor applied immediately before calling the LLM provider.
	 *
	 * Use this to implement provider-specific compatibility transforms (e.g., image limits,
	 * signature preservation, prompt caching markers) without polluting the core tools.
	 *
	 * Note: This is a pure preprocessing hook. It should not execute tools or perform I/O.
	 */
	preprocessMessages?: (
		messages: Message[],
		context: {
			systemPrompt: string;
			tools: AgentTool[];
			model: Model<Api>;
			userMessage?: Message;
		},
		signal?: AbortSignal,
	) => Message[] | Promise<Message[]>;
	/** User identification for tracking */
	user?: {
		/** User UUID */
		id: string;
		/** Organization UUID */
		orgId: string;
	};
	/** Session information for persistence */
	session?: {
		/** Session UUID */
		id: string;
		/** When the session started */
		startedAt: Date;
	};
	/** Optional helper function for running LLM queries (e.g., for summarization) */
	runLLM?: (systemPrompt: string, userPrompt: string) => Promise<string>;
	/** Optional sandbox for isolated tool execution */
	sandbox?: import("../sandbox/types.js").Sandbox;
	/** Sampling temperature override (0.0-2.0, lower = more deterministic) */
	temperature?: number;
	/** Top-p sampling override (0.0-1.0) */
	topP?: number;
}

/**
 * Transport interface for LLM communication.
 *
 * Implementors of this interface handle the actual communication
 * with the LLM provider, including streaming and tool execution.
 */
export interface AgentTransport {
	/**
	 * Execute a conversation turn with a new user message.
	 *
	 * @param messages - Conversation history
	 * @param userMessage - New user message
	 * @param config - Runtime configuration
	 * @param signal - Optional abort signal for cancellation
	 * @returns Async iterable of agent events
	 */
	run(
		messages: Message[],
		userMessage: Message,
		config: AgentRunConfig,
		signal?: AbortSignal,
	): AsyncIterable<AgentEvent>;

	/**
	 * Continue from current context without a new user message.
	 *
	 * Used for:
	 * - Retrying after transient errors (rate limits, overload)
	 * - Continuing after context compaction
	 * - Resuming interrupted tool execution
	 *
	 * @param messages - Current conversation history
	 * @param config - Runtime configuration
	 * @param signal - Optional abort signal for cancellation
	 * @returns Async iterable of agent events
	 */
	continue(
		messages: Message[],
		config: AgentRunConfig,
		signal?: AbortSignal,
	): AsyncIterable<AgentEvent>;

	/**
	 * Optional lightweight connectivity probe for UI health checks.
	 */
	ping?: () => Promise<void>;
}

/**
 * Options for streaming LLM requests.
 *
 * These options are passed to the transport layer when making
 * streaming requests to the LLM provider.
 */
export interface StreamOptions {
	/** Sampling temperature (0.0-2.0, lower = more deterministic) */
	temperature?: number;
	/** Maximum tokens to generate */
	maxTokens?: number;
	/** Abort signal for cancellation */
	signal?: AbortSignal;
	/** API key for authentication */
	apiKey?: string;
	/** Additional headers to include in requests */
	headers?: Record<string, string>;
	/** Authentication type for the request */
	authType?: "api-key" | "anthropic-oauth";
}

/**
 * Cache control hint for prompt caching.
 *
 * Used to mark content that should be cached for faster
 * subsequent requests.
 */
export interface PromptCacheControl {
	/** Cache type - currently only "ephemeral" is supported */
	type: "ephemeral";
}
