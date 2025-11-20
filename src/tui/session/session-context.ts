export class SessionContext {
	private lastUserMessage?: string;
	private lastAssistantMessage?: string;
	private currentRunTools: string[] = [];
	private lastRunTools: string[] = [];
	private artifacts: SessionArtifacts = {};

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
