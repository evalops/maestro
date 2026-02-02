/**
 * Type Definitions for Composer Desktop
 *
 * These types mirror the contracts package for use in the renderer.
 */

export interface Message {
	id?: string;
	role: "user" | "assistant";
	content: string;
	toolCalls?: ToolCall[];
	timestamp?: string;
}

export interface ToolCall {
	id?: string;
	name: string;
	args?: Record<string, unknown>;
	status?: "pending" | "running" | "success" | "error";
	result?: string;
}

export interface Model {
	id: string;
	name: string;
	provider: string;
	description?: string;
	contextLength?: number;
	maxOutput?: number;
}

export interface SessionSummary {
	id: string;
	title?: string;
	createdAt: string;
	updatedAt?: string;
	messageCount: number;
}

export interface Session extends SessionSummary {
	messages: Message[];
}

export interface AgentEvent {
	type: string;
	assistantMessageEvent?: {
		type: string;
		delta?: string;
		content?: string;
		message?: Message;
	};
	message?: Message;
}

export interface WorkspaceStatus {
	cwd: string;
	git: {
		branch: string;
		status: {
			modified: number;
			added: number;
			deleted: number;
			untracked: number;
			total: number;
		};
	} | null;
	server: {
		uptime: number;
		version: string;
	};
}
