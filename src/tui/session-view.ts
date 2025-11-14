import chalk from "chalk";
import type { Agent } from "../agent/agent.js";
import type {
	AgentState,
	AppMessage,
	AssistantMessage,
} from "../agent/types.js";
import type { SessionManager } from "../session-manager.js";
import type { Container, TUI } from "../tui-lib/index.js";
import { Spacer, Text } from "../tui-lib/index.js";

interface SessionViewOptions {
	agent: Agent;
	sessionManager: SessionManager;
	chatContainer: Container;
	ui: TUI;
	applyLoadedSessionContext: () => void;
	showInfoMessage: (message: string) => void;
	onSessionLoaded: (session: { id: string; messageCount: number }) => void;
}

export class SessionView {
	constructor(private readonly options: SessionViewOptions) {}

	showSessionInfo(): void {
		const sessionFile = this.options.sessionManager.getSessionFile();
		const state = this.options.agent.state;

		const userMessages = state.messages.filter((m) => m.role === "user").length;
		const assistantMessages = state.messages.filter(
			(m) => m.role === "assistant",
		).length;
		const toolResults = state.messages.filter(
			(m) => m.role === "toolResult",
		).length;
		const totalMessages = state.messages.length;

		let toolCalls = 0;
		for (const message of state.messages) {
			if (message.role === "assistant") {
				const assistantMsg = message as AssistantMessage;
				toolCalls += assistantMsg.content.filter(
					(c) => c.type === "toolCall",
				).length;
			}
		}

		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const message of state.messages) {
			if (message.role === "assistant") {
				const assistantMsg = message as AssistantMessage;
				totalInput += assistantMsg.usage.input;
				totalOutput += assistantMsg.usage.output;
				totalCacheRead += assistantMsg.usage.cacheRead;
				totalCacheWrite += assistantMsg.usage.cacheWrite;
				totalCost += assistantMsg.usage.cost.total;
			}
		}

		const totalTokens =
			totalInput + totalOutput + totalCacheRead + totalCacheWrite;

		let info = `${chalk.bold("Session Info")}`;
		info += `\n\n${chalk.dim("File:")} ${sessionFile}`;
		info += `\n${chalk.dim("ID:")} ${this.options.sessionManager.getSessionId()}`;
		info += `\n\n${chalk.bold("Messages")}`;
		info += `\n${chalk.dim("User:")} ${userMessages}`;
		info += `\n${chalk.dim("Assistant:")} ${assistantMessages}`;
		info += `\n${chalk.dim("Tool Calls:")} ${toolCalls}`;
		info += `\n${chalk.dim("Tool Results:")} ${toolResults}`;
		info += `\n${chalk.dim("Total:")} ${totalMessages}`;
		info += `\n\n${chalk.bold("Tokens")}`;
		info += `\n${chalk.dim("Input:")} ${totalInput.toLocaleString()}`;
		info += `\n${chalk.dim("Output:")} ${totalOutput.toLocaleString()}`;
		if (totalCacheRead > 0) {
			info += `\n${chalk.dim("Cache Read:")} ${totalCacheRead.toLocaleString()}`;
		}
		if (totalCacheWrite > 0) {
			info += `\n${chalk.dim("Cache Write:")} ${totalCacheWrite.toLocaleString()}`;
		}
		info += `\n${chalk.dim("Total:")} ${totalTokens.toLocaleString()}`;

		if (totalCost > 0) {
			info += `\n\n${chalk.bold("Cost")}`;
			info += `\n${chalk.dim("Total:")} ${totalCost.toFixed(4)}`;
		}

		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(info, 1, 0));
		this.options.ui.requestRender();
	}

	showSessionsList(
		sessions: Array<{
			path: string;
			id: string;
			created: Date;
			modified: Date;
			messageCount: number;
			firstMessage: string;
			allMessagesText: string;
		}>,
	): void {
		this.options.chatContainer.addChild(new Spacer(1));
		if (sessions.length === 0) {
			this.options.chatContainer.addChild(
				new Text(chalk.dim("No saved sessions for this project."), 1, 0),
			);
			this.options.ui.requestRender();
			return;
		}
		const lines = sessions.slice(0, 5).map((session, idx) => {
			const preview = session.firstMessage
				? session.firstMessage.slice(0, 60)
				: "(no messages)";
			return `${idx + 1}. ${chalk.cyan(session.id.slice(0, 8))} · ${chalk.dim(
				session.modified.toLocaleString(),
			)} · ${preview}`;
		});
		this.options.chatContainer.addChild(
			new Text(
				`${chalk.bold("Sessions")}
	${lines.join("\n")}
	Use /sessions load <number> to switch.`,
				1,
				0,
			),
		);
		this.options.ui.requestRender();
	}

	loadSession(index: number, sessions: any[]): boolean {
		if (!Number.isFinite(index) || index <= 0) {
			this.options.showInfoMessage("Usage: /sessions load <number>");
			return false;
		}
		if (sessions.length === 0) {
			this.options.showInfoMessage("No saved sessions to load.");
			return false;
		}
		const selected = sessions[index - 1];
		if (!selected) {
			this.options.showInfoMessage(`No session #${index} found.`);
			return false;
		}
		this.options.sessionManager.setSessionFile(selected.path);
		const loaded = this.options.sessionManager.loadMessages() as AppMessage[];
		this.options.agent.replaceMessages(loaded);
		this.options.applyLoadedSessionContext();
		this.options.onSessionLoaded({
			id: selected.id,
			messageCount: selected.messageCount,
		});
		return true;
	}

	handleSessionsCommand(text: string): void {
		const parts = text.trim().split(/\s+/);
		const sessions = this.options.sessionManager.loadAllSessions();
		if (parts.length === 1 || parts[1] === "list") {
			this.showSessionsList(sessions);
			return;
		}

		if (parts[1] === "load" && parts.length >= 3) {
			const index = Number.parseInt(parts[2], 10);
			if (!this.loadSession(index, sessions)) {
				return;
			}
			return;
		}

		this.options.showInfoMessage("Usage: /sessions [list|load <number>]");
	}
}
