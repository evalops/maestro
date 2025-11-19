export type ComposerRole = "user" | "assistant" | "system" | "tool";

export type ComposerThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high";

export interface ComposerToolCall {
	name: string;
	status: "pending" | "running" | "completed" | "error";
	args?: Record<string, unknown>;
	result?: unknown;
	toolCallId?: string;
}

export interface ComposerMessage {
	role: ComposerRole;
	content: string;
	timestamp?: string;
	thinking?: string;
	tools?: ComposerToolCall[];
	toolName?: string;
	isError?: boolean;
}

export interface ComposerChatRequest {
	model?: string;
	messages: ComposerMessage[];
	thinkingLevel?: ComposerThinkingLevel;
	sessionId?: string;
	stream?: boolean;
}

export interface ComposerSessionSummary {
	id: string;
	title?: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
}

export interface ComposerSession extends ComposerSessionSummary {
	messages: ComposerMessage[];
}

export interface ComposerSessionListResponse {
	sessions: ComposerSessionSummary[];
}

export interface ComposerSessionUpdateEvent {
	type: "session_update";
	sessionId: string;
}
