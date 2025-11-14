export class SessionContext {
	private lastUserMessage?: string;
	private lastAssistantMessage?: string;
	private currentRunTools: string[] = [];
	private lastRunTools: string[] = [];

	setLastUserMessage(text: string): void {
		this.lastUserMessage = text;
	}

	setLastAssistantMessage(text: string): void {
		this.lastAssistantMessage = text;
	}

	resetCurrentRunTools(): void {
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
}
