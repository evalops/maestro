import { Spacer, type TUI, Text } from "@evalops/tui";
import type { Container } from "@evalops/tui";
import type { Agent } from "../../agent/agent.js";
import type { AppMessage } from "../../agent/types.js";
import type { SessionManager } from "../../session/manager.js";
import type { NotificationView } from "../notification-view.js";
import type { SessionContext } from "./session-context.js";

/**
 * Callbacks for branch operations.
 */
export interface BranchControllerCallbacks {
	/** Check if agent is currently running */
	isAgentRunning(): boolean;
	/** Reset the conversation with new messages */
	resetConversation(
		messages: AppMessage[],
		editorSeed?: string,
		toastMessage?: string,
		options?: { preserveSession?: boolean; persistMessages?: boolean },
	): void;
	/** Request UI render */
	requestRender(): void;
	/** Show the user message selector view */
	showUserMessageSelector(): void;
}

/**
 * Options for the branch controller.
 */
export interface BranchControllerOptions {
	agent: Agent;
	sessionManager: SessionManager;
	chatContainer: Container;
	ui: TUI;
	notificationView: NotificationView;
	sessionContext: SessionContext;
	callbacks: BranchControllerCallbacks;
}

/**
 * Controller for handling conversation branching.
 *
 * Allows users to branch the conversation from a previous user message,
 * creating a new session with the conversation truncated at that point.
 */
export class BranchController {
	private readonly agent: Agent;
	private readonly sessionManager: SessionManager;
	private readonly chatContainer: Container;
	private readonly ui: TUI;
	private readonly notificationView: NotificationView;
	private readonly sessionContext: SessionContext;
	private readonly callbacks: BranchControllerCallbacks;

	constructor(options: BranchControllerOptions) {
		this.agent = options.agent;
		this.sessionManager = options.sessionManager;
		this.chatContainer = options.chatContainer;
		this.ui = options.ui;
		this.notificationView = options.notificationView;
		this.sessionContext = options.sessionContext;
		this.callbacks = options.callbacks;
	}

	/**
	 * Handle the /branch command.
	 */
	handleBranchCommand(
		argumentText: string,
		showError: (msg: string) => void,
		showInfo: (msg: string) => void,
	): void {
		if (this.callbacks.isAgentRunning()) {
			showError(
				"Wait for the current run to finish before branching the session.",
			);
			return;
		}

		const messages = this.agent.state.messages ?? [];
		const userMessages = messages
			.map((msg, index) => ({ msg, index }))
			.filter(({ msg }) => "role" in msg && msg.role === "user");

		if (userMessages.length === 0) {
			showInfo("No user messages available to branch from yet.");
			return;
		}

		const arg = argumentText.trim();
		if (!arg) {
			// No argument - show interactive selector
			this.callbacks.showUserMessageSelector();
			return;
		}
		if (arg === "list") {
			this.renderBranchList(userMessages);
			return;
		}

		const targetIndex = Number.parseInt(arg, 10);
		if (!Number.isFinite(targetIndex) || targetIndex < 1) {
			showError("Provide a valid user message number to branch from.");
			return;
		}
		if (targetIndex > userMessages.length) {
			showError(
				`Only ${userMessages.length} user message${userMessages.length === 1 ? "" : "s"} available.`,
			);
			return;
		}

		const selection = userMessages[targetIndex - 1];
		const slice = messages.slice(0, selection.index);
		const editorSeed = this.extractUserText(selection.msg as AppMessage);
		this.createBranch(slice, targetIndex, editorSeed);
	}

	/**
	 * Branch to a specific message index.
	 */
	branchToIndex(messageIndex: number): void {
		const messages = this.agent.state.messages ?? [];
		const userMessages = messages
			.map((msg, index) => ({ msg, index }))
			.filter(({ msg }) => "role" in msg && msg.role === "user");

		const selection = userMessages.find((_, i) => i + 1 === messageIndex);
		if (!selection) {
			this.notificationView.showError(
				`User message #${messageIndex} not found`,
			);
			return;
		}

		const slice = messages.slice(0, selection.index);
		const editorSeed = this.extractUserText(selection.msg as AppMessage);
		this.createBranch(slice, messageIndex, editorSeed);
	}

	private createBranch(
		truncatedMessages: AppMessage[],
		userMessageIndex: number,
		editorSeed: string,
	): void {
		// Create branched session file with preserved history
		const newSessionFile = this.sessionManager.createBranchedSession(
			this.agent.state,
			truncatedMessages.length,
		);
		this.sessionManager.setSessionFile(newSessionFile);

		this.callbacks.resetConversation(
			truncatedMessages,
			editorSeed,
			`Branched to new session before user message #${userMessageIndex}.`,
			{ preserveSession: true },
		);
	}

	private renderBranchList(
		userMessages: Array<{ msg: AppMessage; index: number }>,
	): void {
		const lines: string[] = ["User messages (use /branch <number>):"];
		userMessages.forEach(({ msg }, userIndex) => {
			const created = this.getMessageTimestamp(msg);
			const preview = this.extractUserTextPreview(msg as AppMessage);
			const meta = created ? ` • ${created}` : "";
			lines.push(`${userIndex + 1}. ${preview}${meta}`);
		});
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(lines.join("\n"), 1, 0));
		this.callbacks.requestRender();
	}

	private getMessageTimestamp(message: AppMessage): string | null {
		const ts = "timestamp" in message ? message.timestamp : undefined;
		if (!ts || typeof ts !== "number") return null;
		try {
			return new Date(ts).toLocaleString();
		} catch {
			return null;
		}
	}

	private extractUserText(message: AppMessage): string {
		const content = "content" in message ? message.content : undefined;
		if (typeof content === "string") {
			return content;
		}
		if (Array.isArray(content)) {
			const textBlock = content.find(
				(block): block is { type: "text"; text: string } =>
					block != null &&
					typeof block === "object" &&
					"type" in block &&
					block.type === "text",
			);
			return textBlock?.text ?? "";
		}
		return "";
	}

	private extractUserTextPreview(message: AppMessage): string {
		const text = this.extractUserText(message).replace(/\s+/g, " ").trim();
		if (!text) return "(empty)";
		return text.length > 80 ? `${text.slice(0, 77)}…` : text;
	}
}
