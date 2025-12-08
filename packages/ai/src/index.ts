/**
 * @fileoverview @evalops/ai - Shared Composer AI SDK
 *
 * This package provides the core AI infrastructure for Composer, including:
 * - Model registry and provider management
 * - Provider-agnostic transport layer for LLM communication
 * - Agent event stream primitives for real-time streaming
 * - Type definitions for messages, tools, and configurations
 *
 * ## Architecture
 *
 * ```
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │                         @evalops/ai                                  │
 * ├─────────────────────────────────────────────────────────────────────┤
 * │  ┌─────────────┐  ┌──────────────────┐  ┌─────────────────────────┐ │
 * │  │    Agent    │  │ProviderTransport │  │    Model Registry       │ │
 * │  │ - prompt()  │  │ - Anthropic      │  │ - getProviders()        │ │
 * │  │ - subscribe │  │ - OpenAI         │  │ - getModels(provider)   │ │
 * │  │ - state     │  │ - Google         │  │ - getModel(provider,id) │ │
 * │  └─────────────┘  └──────────────────┘  └─────────────────────────┘ │
 * └─────────────────────────────────────────────────────────────────────┘
 * ```
 *
 * ## Quick Start
 *
 * ```typescript
 * import { Agent, ProviderTransport, getModel } from "@evalops/ai";
 *
 * // Create transport with API key provider
 * const transport = new ProviderTransport({
 *   getApiKey: () => process.env.ANTHROPIC_API_KEY,
 * });
 *
 * // Get model configuration
 * const model = getModel("anthropic", "claude-sonnet-4-5-20250929");
 *
 * // Create and use agent
 * const agent = new Agent({
 *   transport,
 *   initialState: { model, tools: [] }
 * });
 *
 * agent.subscribe((event) => {
 *   if (event.type === 'content_block_delta') {
 *     process.stdout.write(event.text);
 *   }
 * });
 *
 * await agent.prompt("Hello, world!");
 * ```
 *
 * ## Supported Providers
 *
 * | Provider | Models | API |
 * |----------|--------|-----|
 * | Anthropic | Claude 3.5/4 | anthropic-messages |
 * | OpenAI | GPT-4o, o1 | openai-completions |
 * | Google | Gemini 2.0 | google-generative-ai |
 * | Bedrock | Claude via AWS | bedrock-converse |
 *
 * @module @evalops/ai
 * @see {@link Agent} for the main interaction class
 * @see {@link ProviderTransport} for LLM communication
 */

/**
 * Core Agent class for managing LLM interactions.
 * Handles conversation state, tool execution, and streaming responses.
 * @see {@link AgentOptions} for configuration
 */
export { Agent, type AgentOptions } from "../../../src/agent/agent.js";

/**
 * Transport layer for LLM provider communication.
 * Abstracts away provider-specific APIs into a unified streaming interface.
 * @see {@link ProviderTransportOptions} for configuration
 */
export {
	ProviderTransport,
	type ProviderTransportOptions,
} from "../../../src/agent/transport.js";

/**
 * Model registry functions for discovering available LLM models.
 *
 * @example
 * ```typescript
 * // List all providers
 * const providers = getProviders(); // ['anthropic', 'openai', 'google', ...]
 *
 * // Get models for a provider
 * const models = getModels('anthropic'); // [Model, Model, ...]
 *
 * // Get a specific model
 * const claude = getModel('anthropic', 'claude-sonnet-4-5-20250929');
 * ```
 */
export {
	getProviders,
	getModels,
	getModel,
} from "../../../src/models/builtin.js";

/**
 * Agent state interface representing the current state of an agent instance.
 * Includes messages, model configuration, tools, and streaming status.
 */
export type { AgentState } from "../../../src/agent/types.js";

/**
 * Core type definitions for the AI SDK.
 *
 * ## Message Types
 * - {@link Message} - Union of all message types
 * - {@link UserMessage} - Messages from the user
 * - {@link AssistantMessage} - Responses from the AI
 * - {@link ToolResultMessage} - Results from tool executions
 *
 * ## Content Types
 * - {@link TextContent} - Plain text content
 * - {@link ImageContent} - Base64-encoded image content
 * - {@link ThinkingContent} - Extended reasoning traces
 *
 * ## Tool Types
 * - {@link Tool} - Tool definition schema
 * - {@link AgentTool} - Tool with execute function
 * - {@link ToolCall} - A specific tool invocation
 *
 * ## Configuration Types
 * - {@link Model} - LLM model configuration
 * - {@link AgentRunConfig} - Runtime configuration for agent execution
 * - {@link StreamOptions} - Options for streaming requests
 */
export type {
	/** Events emitted during agent execution (streaming deltas, tool calls, etc.) */
	AgentEvent,
	/** Runtime configuration for agent execution */
	AgentRunConfig,
	/** Tool definition with execute function */
	AgentTool,
	/** Result returned from tool execution */
	AgentToolResult,
	/** Transport interface for LLM communication */
	AgentTransport,
	/** API format identifier (openai-completions, anthropic-messages, etc.) */
	Api,
	/** Application-level message (may include attachments) */
	AppMessage,
	/** Message from the AI assistant */
	AssistantMessage,
	/** Streaming events during assistant message construction */
	AssistantMessageEvent,
	/** File attachment (image or document) */
	Attachment,
	/** Conversation context with system prompt and messages */
	Context,
	/** Base64-encoded image content block */
	ImageContent,
	/** Union type for all message types */
	Message,
	/** LLM model configuration */
	Model,
	/** In-flight tool call being executed */
	PendingToolCall,
	/** Cache control hint for prompt caching */
	PromptCacheControl,
	/** Message in the prompt queue */
	QueuedMessage,
	/** Reasoning effort level for extended thinking */
	ReasoningEffort,
	/** Reason why generation stopped */
	StopReason,
	/** Options for streaming LLM requests */
	StreamOptions,
	/** Plain text content block */
	TextContent,
	/** Extended reasoning/thinking content block */
	ThinkingContent,
	/** User-configurable thinking level */
	ThinkingLevel,
	/** Tool definition schema (without execute) */
	Tool,
	/** A specific tool invocation within a message */
	ToolCall,
	/** Result message from tool execution */
	ToolResultMessage,
	/** Token usage and cost information */
	Usage,
	/** Message from the user */
	UserMessage,
	/** User message with file attachments */
	UserMessageWithAttachments,
} from "../../../src/agent/types.js";
