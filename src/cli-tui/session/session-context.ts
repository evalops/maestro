import type { ToolResultMessage } from "../../agent/types.js";
import { PromptHistoryStore } from "../history/prompt-history.js";
import { ToolHistoryStore } from "../history/tool-history.js";

export class SessionContext {
	private lastUserMessage?: string;
	private lastAssistantMessage?: string;
	private currentRunTools: string[] = [];
	private lastRunTools: string[] = [];
	private artifacts: SessionArtifacts = {};
	private promptHistory = new PromptHistoryStore();
	private toolHistory = new ToolHistoryStore();

	setLastUserMessage(text: string): void {
		this.lastUserMessage = text;
	}

	setLastAssistantMessage(text: string): void {
		this.lastAssistantMessage = text;
	}

	beginTurn(): void {
		this.currentRunTools = [];
	}

	recordToolUsage(toolName: string): void {
		this.currentRunTools.push(toolName);
	}

	recordPrompt(text: string): void {
		this.promptHistory.add(text);
	}

	recordToolStart(
		toolCallId: string,
		toolName: string,
		args: Record<string, unknown> = {},
	): void {
		this.toolHistory.recordStart(toolCallId, toolName, args);
	}

	recordToolEnd(
		toolCallId: string,
		toolName: string,
		result: ToolResultMessage,
		isError: boolean,
	): void {
		this.toolHistory.recordEnd(toolCallId, toolName, result, isError);
	}

	completeTurn(lastAssistantText?: string): void {
		if (lastAssistantText) {
			this.lastAssistantMessage = lastAssistantText;
		}
		this.lastRunTools = [...this.currentRunTools];
		this.currentRunTools = [];
	}

	getLastUserMessage(): string | undefined {
		return this.lastUserMessage;
	}

	getLastAssistantMessage(): string | undefined {
		return this.lastAssistantMessage;
	}

	getLastRunToolNames(): string[] {
		return this.lastRunTools;
	}

	getPromptHistory(): PromptHistoryStore {
		return this.promptHistory;
	}

	getToolHistory(): ToolHistoryStore {
		return this.toolHistory;
	}

	recordShareArtifact(filePath: string): void {
		this.artifacts.lastShare = {
			filePath,
			timestamp: Date.now(),
		};
	}

	recordCompactionArtifact(details: {
		beforeTokens: number;
		afterTokens: number;
		trigger: "auto" | "manual";
	}): void {
		this.artifacts.lastCompaction = {
			...details,
			timestamp: Date.now(),
		};
	}

	recordPasteSummaryArtifact(details: {
		placeholder: string;
		lineCount: number;
		charCount: number;
		summaryPreview: string;
	}): void {
		this.artifacts.lastPasteSummary = {
			...details,
			timestamp: Date.now(),
		};
	}

	getArtifacts(): SessionArtifacts {
		return { ...this.artifacts };
	}

	resetArtifacts(): void {
		this.artifacts = {};
	}
}

export interface SessionArtifacts {
	lastShare?: { filePath: string; timestamp: number };
	lastCompaction?: {
		beforeTokens: number;
		afterTokens: number;
		trigger: "auto" | "manual";
		timestamp: number;
	};
	lastPasteSummary?: {
		placeholder: string;
		lineCount: number;
		charCount: number;
		summaryPreview: string;
		timestamp: number;
	};
}
