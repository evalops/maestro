/**
 * Type Definitions for Composer Desktop
 *
 * These types mirror the contracts package for use in the renderer.
 */

import type {
	ComposerMessage,
	ComposerToolCallContent,
} from "@evalops/contracts";

export interface Message {
	id?: string;
	role: "user" | "assistant";
	content: string;
	thinking?: string;
	toolCalls?: ToolCall[];
	timestamp?: string;
}

export type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "max";

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
		contentIndex?: number;
		delta?: string;
		content?: string;
		message?: ComposerMessage;
		partial?: ComposerMessage;
		toolCallId?: string;
		toolCallName?: string;
		toolCallArgs?: Record<string, unknown>;
		toolCallArgsTruncated?: boolean;
		toolCall?: ComposerToolCallContent;
	};
	message?: Message | ComposerMessage;
	toolCallId?: string;
	toolName?: string;
	args?: Record<string, unknown>;
	partialResult?: unknown;
	result?: unknown;
	isError?: boolean;
	status?: string;
	details?: Record<string, unknown>;
	summary?: string;
	firstKeptEntryIndex?: number;
	tokensBefore?: number;
	auto?: boolean;
	customInstructions?: string;
	timestamp?: string;
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

export interface AutomationTask {
	id: string;
	name: string;
	prompt: string;
	schedule: string | null;
	scheduleLabel?: string;
	scheduleKind?: "once" | "daily" | "weekly" | "cron";
	scheduleTime?: string;
	scheduleDays?: number[];
	runAt?: string;
	cronExpression?: string;
	nextRun: string | null;
	timezone: string;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
	lastRunAt?: string;
	lastRunStatus?: "success" | "failure" | "skipped";
	lastRunError?: string;
	lastRunDurationMs?: number;
	lastOutput?: string;
	runCount: number;
	running?: boolean;
	runHistory?: AutomationRunRecord[];
	runWindow?: AutomationRunWindow;
	exclusive?: boolean;
	notifyOnSuccess?: boolean;
	notifyOnFailure?: boolean;
	sessionMode?: "reuse" | "new";
	sessionId?: string;
	lastSessionId?: string;
	contextPaths?: string[];
	contextFolders?: string[];
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export interface AutomationRunRecord {
	id: string;
	startedAt: string;
	finishedAt: string;
	durationMs?: number;
	status: "success" | "failure" | "skipped";
	trigger?: "manual" | "schedule";
	error?: string;
	output?: string;
	sessionId?: string;
}

export interface AutomationRunWindow {
	start: string;
	end: string;
	days?: number[];
}
