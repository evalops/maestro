import type { TSchema } from "@sinclair/typebox";
import type {
	ActionApprovalDecision,
	ActionApprovalRequest,
} from "./action-approval.js";

export type Api =
	| "openai-completions"
	| "openai-responses"
	| "anthropic-messages"
	| "google-generative-ai";

export type KnownProvider =
	| "anthropic"
	| "google"
	| "openai"
	| "xai"
	| "groq"
	| "cerebras"
	| "openrouter"
	| "zai";

export type Provider = KnownProvider | string;

export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: Api;
	provider: Provider;
	model: string;
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	timestamp: number;
}

export interface ToolResultMessage<TDetails = unknown> {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	details?: TDetails;
	isError: boolean;
	timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export interface Tool<TParameters extends TSchema = TSchema> {
	name: string;
	description: string;
	parameters: TParameters;
}

export interface ToolAnnotations {
	/** If true, the tool does not modify its environment */
	readOnlyHint?: boolean;
	/** If true, the tool may perform destructive updates */
	destructiveHint?: boolean;
	/** If true, calling repeatedly with same args has no additional effect */
	idempotentHint?: boolean;
	/** If true, the tool interacts with external systems */
	openWorldHint?: boolean;
}

export interface AgentTool<
	TParameters extends TSchema = TSchema,
	TDetails = unknown,
> {
	name: string;
	label?: string;
	description: string;
	parameters: TParameters;
	/** Tool behavior hints from MCP annotations */
	annotations?: ToolAnnotations;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	) => AgentToolResult<TDetails> | Promise<AgentToolResult<TDetails>>;
}

export interface AgentToolResult<TDetails = unknown> {
	content: (TextContent | ImageContent)[];
	details?: TDetails;
	isError?: boolean;
}

export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}

export type AssistantMessageEvent =
	| {
			type: "start";
			partial: AssistantMessage;
	  }
	| {
			type: "text_start";
			contentIndex: number;
			partial: AssistantMessage;
	  }
	| {
			type: "text_delta";
			contentIndex: number;
			delta: string;
			partial: AssistantMessage;
	  }
	| {
			type: "text_end";
			contentIndex: number;
			content: string;
			partial: AssistantMessage;
	  }
	| {
			type: "thinking_start";
			contentIndex: number;
			partial: AssistantMessage;
	  }
	| {
			type: "thinking_delta";
			contentIndex: number;
			delta: string;
			partial: AssistantMessage;
	  }
	| {
			type: "thinking_end";
			contentIndex: number;
			content: string;
			partial: AssistantMessage;
	  }
	| {
			type: "toolcall_start";
			contentIndex: number;
			partial: AssistantMessage;
	  }
	| {
			type: "toolcall_delta";
			contentIndex: number;
			delta: string;
			partial: AssistantMessage;
	  }
	| {
			type: "toolcall_end";
			contentIndex: number;
			toolCall: ToolCall;
			partial: AssistantMessage;
	  }
	| {
			type: "done";
			reason: Extract<StopReason, "stop" | "length" | "toolUse">;
			message: AssistantMessage;
	  }
	| {
			type: "error";
			reason: Extract<StopReason, "aborted" | "error">;
			error: AssistantMessage;
	  };

export interface Model<TApi extends Api> {
	id: string;
	name: string;
	api: TApi;
	provider: Provider;
	baseUrl: string;
	reasoning: boolean;
	toolUse?: boolean;
	input: ("text" | "image")[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow: number;
	maxTokens: number;
}

export interface Attachment {
	id: string;
	type: "image" | "document";
	fileName: string;
	mimeType: string;
	size: number;
	content: string;
	extractedText?: string;
	preview?: string;
}

export type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "max";

export type UserMessageWithAttachments = UserMessage & {
	attachments?: Attachment[];
};

export type CustomMessages = Record<string, never>;

export type AppMessage =
	| AssistantMessage
	| UserMessageWithAttachments
	| Message
	| CustomMessages[keyof CustomMessages];

export interface PendingToolCall {
	toolName: string;
}

export interface AgentState {
	systemPrompt: string;
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	tools: AgentTool[];
	messages: AppMessage[];
	isStreaming: boolean;
	streamMessage: Message | null;
	pendingToolCalls: Map<string, PendingToolCall>;
	error?: string;
	user?: {
		id: string; // UUID
		orgId: string; // UUID
	};
}

export type AgentEvent =
	| {
			type: "agent_start";
	  }
	| {
			type: "agent_end";
			messages: AppMessage[];
			aborted?: boolean;
	  }
	| {
			type: "status";
			status: string;
			details: Record<string, unknown>;
	  }
	| {
			type: "error";
			message: string;
	  }
	| {
			type: "turn_start";
	  }
	| {
			type: "turn_end";
			message: AppMessage;
			toolResults: AppMessage[];
	  }
	| {
			type: "message_start";
			message: AppMessage;
	  }
	| {
			type: "message_update";
			message: AppMessage;
			assistantMessageEvent: AssistantMessageEvent;
	  }
	| {
			type: "message_end";
			message: AppMessage;
	  }
	| {
			type: "tool_execution_start";
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: ToolResultMessage;
			isError: boolean;
	  }
	| {
			type: "action_approval_required";
			request: ActionApprovalRequest;
	  }
	| {
			type: "action_approval_resolved";
			request: ActionApprovalRequest;
			decision: ActionApprovalDecision;
	  };

export interface QueuedMessage<TOriginal = AppMessage> {
	original: TOriginal;
	llm?: Message;
}

export interface AgentRunConfig {
	systemPrompt: string;
	tools: AgentTool[];
	model: Model<Api>;
	reasoning?: ReasoningEffort;
	getQueuedMessages?: <T>() => Promise<QueuedMessage<T>[]>;
	user?: {
		id: string; // UUID
		orgId: string; // UUID
	};
}

export interface AgentTransport {
	run(
		messages: Message[],
		userMessage: Message,
		config: AgentRunConfig,
		signal?: AbortSignal,
	): AsyncIterable<AgentEvent>;
}

export interface StreamOptions {
	temperature?: number;
	maxTokens?: number;
	signal?: AbortSignal;
	apiKey?: string;
	headers?: Record<string, string>;
	authType?: "api-key" | "chatgpt" | "anthropic-oauth";
}

export interface PromptCacheControl {
	type: "ephemeral";
}
