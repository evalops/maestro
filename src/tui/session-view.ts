import type { Agent } from "../agent/agent.js";
import type {
	AgentState,
	AppMessage,
	AssistantMessage,
} from "../agent/types.js";
import type { SessionManager } from "../session-manager.js";
import {
	badge,
	heading,
	labeledValue,
	muted,
	separator as themedSeparator,
} from "../style/theme.js";
import type { Container, TUI } from "../tui-lib/index.js";
import { Spacer, Text } from "../tui-lib/index.js";
import type {
	SessionDataProvider,
	SessionItem,
} from "./session-data-provider.js";

interface SessionViewOptions {
	agent: Agent;
	sessionManager: SessionManager;
	chatContainer: Container;
	ui: TUI;
	sessionDataProvider: SessionDataProvider;
	openSessionSwitcher: () => void;
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

		const sessionMeta = [
			heading("Session overview"),
			labeledValue("File", sessionFile ?? muted("(not yet persisted)")),
			labeledValue(
				"ID",
				this.options.sessionManager.getSessionId() ?? muted("(unset)"),
			),
			"",
		];

		const messageBlock = [
			badge("Messages", undefined, "info"),
			`  ${labeledValue("User", userMessages.toString())}`,
			`  ${labeledValue("Assistant", assistantMessages.toString())}`,
			`  ${labeledValue("Tool Calls", toolCalls.toString())}`,
			`  ${labeledValue("Tool Results", toolResults.toString())}`,
			`  ${labeledValue("Total", totalMessages.toString())}`,
		].join("\n");

		const tokenLines = [
			badge("Tokens", undefined, "info"),
			`  ${labeledValue("Input", totalInput.toLocaleString())}`,
			`  ${labeledValue("Output", totalOutput.toLocaleString())}`,
		];
		if (totalCacheRead > 0) {
			tokenLines.push(
				`  ${labeledValue("Cache Read", totalCacheRead.toLocaleString())}`,
			);
		}
		if (totalCacheWrite > 0) {
			tokenLines.push(
				`  ${labeledValue("Cache Write", totalCacheWrite.toLocaleString())}`,
			);
		}
		tokenLines.push(`  ${labeledValue("Total", totalTokens.toLocaleString())}`);

		const sections = [...sessionMeta, messageBlock, "", tokenLines.join("\n")];
		if (totalCost > 0) {
			sections.push(
				"",
				[
					badge("Cost", undefined, "warn"),
					`  ${labeledValue("Total", totalCost.toFixed(4))}`,
				].join("\n"),
			);
		}

		const info = sections.join("\n");
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
				new Text(muted("No saved sessions for this project."), 1, 0),
			);
			this.options.ui.requestRender();
			return;
		}
		const lines = sessions.slice(0, 5).map((session, idx) => {
			const preview = session.firstMessage
				? session.firstMessage.slice(0, 60)
				: "(no messages)";
			const badgeLabel = badge(`#${idx + 1}`, session.id.slice(0, 8), "info");
			const meta = `${muted(session.modified.toLocaleString())}${themedSeparator()}${muted(`${session.messageCount} msgs`)}`;
			return `${badgeLabel} ${themedSeparator()} ${meta}
	${muted(preview)}`;
		});
		const body = `${heading("Sessions")}
${lines.join("\n")}

${muted("Use /sessions load <number> to switch.")}`;
		this.options.chatContainer.addChild(new Text(body, 1, 0));
		this.options.ui.requestRender();
	}

	loadSession(index: number, sessions: SessionItem[]): boolean {
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
		return this.loadSessionFromItem(selected);
	}

	loadSessionFromItem(session: SessionItem): boolean {
		if (!session?.path) {
			this.options.showInfoMessage("Unable to load that session.");
			return false;
		}
		this.options.sessionManager.setSessionFile(session.path);
		const loaded = this.options.sessionManager.loadMessages() as AppMessage[];
		this.options.agent.replaceMessages(loaded);
		this.options.applyLoadedSessionContext();
		this.options.onSessionLoaded({
			id: session.id,
			messageCount: session.messageCount,
		});
		return true;
	}

	handleSessionsCommand(text: string): void {
		const parts = text.trim().split(/\s+/);
		if (parts.length === 1) {
			this.options.openSessionSwitcher();
			return;
		}

		if (parts[1] === "list") {
			if (parts[2] === "text") {
				const sessions = this.options.sessionDataProvider.loadSessions();
				this.showSessionsList(sessions);
			} else {
				this.options.openSessionSwitcher();
			}
			return;
		}

		const sessions = this.options.sessionDataProvider.loadSessions();

		if (parts[1] === "load" && parts.length >= 3) {
			const index = Number.parseInt(parts[2], 10);
			if (!this.loadSession(index, sessions)) {
				return;
			}
			return;
		}

		if (["favorite", "fav", "star"].includes(parts[1]) && parts.length >= 3) {
			const index = Number.parseInt(parts[2], 10);
			if (!Number.isFinite(index) || index <= 0) {
				this.options.showInfoMessage("Usage: /sessions favorite <number>");
				return;
			}
			const target = sessions[index - 1];
			if (!target) {
				this.options.showInfoMessage(`No session #${index} found.`);
				return;
			}
			this.options.sessionDataProvider.toggleFavorite(target.path, true);
			this.options.showInfoMessage(`Favorited session #${index}.`);
			return;
		}

		if (
			["unfavorite", "unfav", "unstar"].includes(parts[1]) &&
			parts.length >= 3
		) {
			const index = Number.parseInt(parts[2], 10);
			if (!Number.isFinite(index) || index <= 0) {
				this.options.showInfoMessage("Usage: /sessions unfavorite <number>");
				return;
			}
			const target = sessions[index - 1];
			if (!target) {
				this.options.showInfoMessage(`No session #${index} found.`);
				return;
			}
			this.options.sessionDataProvider.toggleFavorite(target.path, false);
			this.options.showInfoMessage(`Removed favorite for session #${index}.`);
			return;
		}

		this.options.showInfoMessage(
			"Usage: /sessions [list|load <number>|favorite <number>|unfavorite <number>]",
		);
	}
}
