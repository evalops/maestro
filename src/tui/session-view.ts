import { existsSync } from "node:fs";
import type { Container, TUI } from "@evalops/tui";
import { Spacer, Text } from "@evalops/tui";
import type { Agent } from "../agent/agent.js";
import type {
	AgentState,
	AppMessage,
	AssistantMessage,
} from "../agent/types.js";
import {
	buildConversationModel,
	isRenderableAssistantMessage,
	isRenderableToolResultMessage,
	isRenderableUserMessage,
} from "../conversation/render-model.js";
import type { SessionManager } from "../session-manager.js";
import {
	badge,
	heading,
	labeledValue,
	muted,
	separator as themedSeparator,
} from "../style/theme.js";
import { normalizeUsage } from "./footer-utils.js";
import type { SessionArtifacts, SessionContext } from "./session-context.js";
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
	summarizeSession: (session: SessionItem) => Promise<void>;
	applyLoadedSessionContext: () => void;
	showInfoMessage: (message: string) => void;
	onSessionLoaded: (session: { id: string; messageCount: number }) => void;
	sessionContext: SessionContext;
}

export class SessionView {
	constructor(private readonly options: SessionViewOptions) {}

	showSessionInfo(): void {
		const sessionFile = this.options.sessionManager.getSessionFile();
		const state = this.options.agent.state;

		const renderables = buildConversationModel(state.messages as AppMessage[]);
		const userMessages = renderables.filter((message) =>
			isRenderableUserMessage(message),
		).length;
		const assistantMessages = renderables.filter((message) =>
			isRenderableAssistantMessage(message),
		).length;
		const toolResults = renderables.filter((message) =>
			isRenderableToolResultMessage(message),
		).length;
		const totalMessages = renderables.length;
		const toolCalls = renderables
			.filter((message) => isRenderableAssistantMessage(message))
			.reduce((sum, message) => sum + message.toolCalls.length, 0);

		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const message of state.messages) {
			if (message.role === "assistant") {
				const assistantMsg = message as AssistantMessage;
				const usage = normalizeUsage(assistantMsg.usage);
				totalInput += usage.input;
				totalOutput += usage.output;
				totalCacheRead += usage.cacheRead;
				totalCacheWrite += usage.cacheWrite;
				totalCost += usage.cost.total;
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

		const recentContext = this.renderRecentContext();
		if (recentContext) {
			sections.push("", recentContext);
		}

		const artifactSection = this.renderArtifacts();
		if (artifactSection) {
			sections.push("", artifactSection);
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

	handleSessionCommand(text: string): void {
		const parts = text.trim().split(/\s+/);
		if (parts.length === 1 || parts[1] === "info") {
			this.showSessionInfo();
			return;
		}

		const action = parts[1];

		if (["favorite", "fav", "star"].includes(action)) {
			const sessionPath = this.getPersistedSessionPath();
			if (!sessionPath) return;
			this.options.sessionManager.setSessionFavorite(sessionPath, true);
			this.options.sessionDataProvider.refresh();
			this.options.showInfoMessage("Favorited current session.");
			return;
		}

		if (["unfavorite", "unfav", "unstar"].includes(action)) {
			const sessionPath = this.getPersistedSessionPath();
			if (!sessionPath) return;
			this.options.sessionManager.setSessionFavorite(sessionPath, false);
			this.options.sessionDataProvider.refresh();
			this.options.showInfoMessage("Removed favorite from current session.");
			return;
		}

		if (action === "summary") {
			const summary = parts.slice(2).join(" ").trim();
			if (!summary) {
				this.options.showInfoMessage("Usage: /session summary <text>");
				return;
			}
			const sessionPath = this.getPersistedSessionPath();
			if (!sessionPath) return;
			this.options.sessionManager.saveSessionSummary(summary, sessionPath);
			this.options.sessionDataProvider.refresh();
			this.options.showInfoMessage("Saved session summary.");
			return;
		}

		this.options.showInfoMessage(
			"Usage: /session [info|favorite|unfavorite|summary <text>]",
		);
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

		if (parts[1] === "summarize" && parts.length >= 3) {
			const index = Number.parseInt(parts[2], 10);
			if (!Number.isFinite(index) || index <= 0) {
				this.options.showInfoMessage("Usage: /sessions summarize <number>");
				return;
			}
			const target = sessions[index - 1];
			if (!target) {
				this.options.showInfoMessage(`No session #${index} found.`);
				return;
			}
			void this.options.summarizeSession(target);
			return;
		}

		this.options.showInfoMessage(
			"Usage: /sessions [list|load <number>|favorite <number>|unfavorite <number>|summarize <number>]",
		);
	}

	private renderArtifacts(): string | null {
		const artifacts: SessionArtifacts =
			this.options.sessionContext.getArtifacts();
		const lines: string[] = [];
		if (artifacts.lastShare) {
			lines.push(
				`${badge("Share", undefined, "info")} ${labeledValue(
					"File",
					artifacts.lastShare.filePath,
				)} ${muted(new Date(artifacts.lastShare.timestamp).toLocaleString())}`,
			);
		}
		if (artifacts.lastCompaction) {
			const { beforeTokens, afterTokens, trigger, timestamp } =
				artifacts.lastCompaction;
			lines.push(
				`${badge("Compaction", undefined, "warn")} ${labeledValue(
					"Before→After",
					`${beforeTokens.toLocaleString()} → ${afterTokens.toLocaleString()}`,
				)} ${labeledValue("Trigger", trigger)} ${muted(
					new Date(timestamp).toLocaleString(),
				)}`,
			);
		}
		if (artifacts.lastPasteSummary) {
			const { placeholder, lineCount, charCount, summaryPreview, timestamp } =
				artifacts.lastPasteSummary;
			const previewLine = summaryPreview ? `${muted(summaryPreview)}` : "";
			lines.push(
				`${badge("Paste", undefined, "info")} ${labeledValue(
					"Marker",
					placeholder,
				)} ${labeledValue(
					"Size",
					`~${lineCount} lines / ${charCount} chars`,
				)} ${muted(new Date(timestamp).toLocaleString())}${
					previewLine ? `\n${previewLine}` : ""
				}`,
			);
		}
		if (!lines.length) {
			return null;
		}
		return `${heading("Recent artifacts")}
${lines.join("\n")}`;
	}

	private renderRecentContext(): string | null {
		const lastUser = this.options.sessionContext.getLastUserMessage();
		const lastAssistant = this.options.sessionContext.getLastAssistantMessage();
		const lastTools = this.options.sessionContext.getLastRunToolNames();
		const items: string[] = [];
		if (lastUser) {
			items.push(
				`${badge("User", undefined, "info")} ${this.preview(lastUser)}`,
			);
		}
		if (lastAssistant) {
			items.push(
				`${badge("Assistant", undefined, "info")} ${this.preview(lastAssistant)}`,
			);
		}
		if (lastTools.length) {
			items.push(
				`${badge("Tools", undefined, "info")} ${lastTools.join(", ")}`,
			);
		}
		if (!items.length) {
			return null;
		}
		return `${heading("Recent context")}
${items.join("\n")}`;
	}

	private preview(text: string, limit = 140): string {
		const singleLine = text.replace(/\s+/g, " ").trim();
		if (singleLine.length <= limit) {
			return singleLine;
		}
		return `${singleLine.slice(0, limit - 1)}…`;
	}

	private getPersistedSessionPath(): string | null {
		const sessionPath = this.options.sessionManager.getSessionFile();
		if (!sessionPath || !existsSync(sessionPath)) {
			this.options.showInfoMessage(
				"Session not yet persisted—send/receive a message before tagging it.",
			);
			return null;
		}
		return sessionPath;
	}
}
