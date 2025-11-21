import type { Container, TUI } from "@evalops/tui";
import type { Agent } from "../../agent/agent.js";
import type { AppMessage } from "../../agent/types.js";
import type { SessionManager } from "../../session/manager.js";
import type { CustomEditor } from "../custom-editor.js";
import type { NotificationView } from "../notification-view.js";
import {
	type UserMessageItem,
	UserMessageSelectorComponent,
} from "./user-message-selector.js";

interface UserMessageSelectorViewOptions {
	agent: Agent;
	sessionManager: SessionManager;
	editor: CustomEditor;
	editorContainer: Container;
	chatContainer: Container;
	ui: TUI;
	notificationView: NotificationView;
	onBranchCreated: () => void;
}

export class UserMessageSelectorView {
	private selector: UserMessageSelectorComponent | null = null;

	constructor(private readonly options: UserMessageSelectorViewOptions) {}

	show(): void {
		if (this.selector) {
			return;
		}

		// Extract user messages from agent state
		const userMessages: UserMessageItem[] = [];
		const messages = this.options.agent.state.messages;

		for (let i = 0; i < messages.length; i++) {
			const message = messages[i];
			if (message.role === "user") {
				// Extract text content from message
				let text = "";
				if (typeof message.content === "string") {
					text = message.content;
				} else if (Array.isArray(message.content)) {
					const textBlocks = message.content.filter(
						(c: any) => c.type === "text",
					);
					text = textBlocks
						.map((c: any) => c.text)
						.join(" ")
						.replace(/\n/g, " ")
						// biome-ignore lint/suspicious/noControlCharactersInRegex: Need to strip ANSI escape sequences
						.replace(/\x1b\[[0-9;]*m/g, "") // Strip ANSI color codes
						// biome-ignore lint/suspicious/noControlCharactersInRegex: Need to strip ANSI escape sequences
						.replace(/\x1b\[.*?[@-~]/g, "") // Strip other ANSI sequences
						.trim();
				}

				// Include all user messages, even those with no text content
				userMessages.push({
					index: i,
					text: text ? text.substring(0, 200) : "(no text content)", // Truncate for display
				});
			}
		}

		// Check if we have any messages to branch from (allow single user message branching)
		if (userMessages.length === 0) {
			this.options.notificationView.showInfo("No messages to branch from");
			return;
		}

		this.selector = new UserMessageSelectorComponent(
			userMessages,
			(messageIndex) => this.handleBranch(messageIndex),
			() => this.hide(),
		);

		this.options.editorContainer.clear();
		this.options.editorContainer.addChild(this.selector);
		this.options.ui.setFocus(this.selector.getMessageList());
		this.options.ui.requestRender();
	}

	private handleBranch(messageIndex: number): void {
		// Validate messageIndex is within bounds
		if (
			messageIndex < 0 ||
			messageIndex >= this.options.agent.state.messages.length
		) {
			this.options.notificationView.showError(
				`Invalid message index: ${messageIndex}. Message array may have been modified.`,
			);
			this.hide();
			return;
		}

		// Get the selected user message text to put in the editor
		const selectedMessage = this.options.agent.state.messages[messageIndex];
		let selectedText = "";
		if (typeof selectedMessage.content === "string") {
			selectedText = selectedMessage.content;
		} else if (Array.isArray(selectedMessage.content)) {
			const textBlocks = selectedMessage.content.filter(
				(c: any) => c.type === "text",
			);
			// Preserve newlines when placing in editor (join with newline, not space)
			selectedText = textBlocks
				.map((c: any) => c.text)
				.join("\n")
				.trim();
		}

		// Create a branched session with messages UP TO (but not including) the selected message
		const newSessionFile = this.options.sessionManager.createBranchedSession(
			this.options.agent.state,
			messageIndex,
		);

		// Set the new session file as active
		this.options.sessionManager.setSessionFile(newSessionFile);

		// Calculate user message number BEFORE truncating messages
		const originalMessages = this.options.agent.state.messages;
		const userMessages = originalMessages.filter((m) => m.role === "user");
		const userMessageNumber =
			userMessages.findIndex(
				(m) => originalMessages.indexOf(m) === messageIndex,
			) + 1;

		// Truncate messages in agent state to before the selected message
		const truncatedMessages = originalMessages.slice(0, messageIndex);
		this.options.agent.replaceMessages(truncatedMessages);

		// Hide selector and restore editor
		this.hide();

		// Put the selected message in the editor
		this.options.editor.setText(selectedText);

		// Notify callback to refresh UI
		this.options.onBranchCreated();

		// Show success message
		this.options.notificationView.showToast(
			`Branched to new session before user message #${userMessageNumber}`,
			"success",
		);

		this.options.ui.requestRender();
	}

	private hide(): void {
		if (!this.selector) {
			return;
		}
		this.options.editorContainer.clear();
		this.options.editorContainer.addChild(this.options.editor);
		this.selector = null;
		this.options.ui.setFocus(this.options.editor);
	}
}
