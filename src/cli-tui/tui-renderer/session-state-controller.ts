/**
 * SessionStateController - Manages session resets, recovery, and rendering.
 *
 * Keeps session lifecycle logic out of TuiRenderer while preserving behavior.
 */

import type { Container, ScrollContainer } from "@evalops/tui";
import type { Agent } from "../../agent/agent.js";
import { listSessionBackups } from "../../agent/session-recovery.js";
import type { SessionRecoveryManager } from "../../agent/session-recovery.js";
import type {
	AgentState,
	AppMessage,
	ThinkingLevel,
} from "../../agent/types.js";
import { getRegisteredModels } from "../../models/registry.js";
import type { SessionManager } from "../../session/manager.js";
import type { CommandExecutionContext } from "../commands/types.js";
import type { CustomEditor } from "../custom-editor.js";
import type { FooterComponent } from "../footer.js";
import type { MessageView } from "../message-view.js";
import type { NotificationView } from "../notification-view.js";
import type { PlanView } from "../plan-view.js";
import type { SessionContext } from "../session/session-context.js";
import type { ToolOutputView } from "../tool-output-view.js";

export interface SessionStateControllerDeps {
	agent: Agent;
	sessionManager: SessionManager;
	sessionContext: SessionContext;
	sessionRecoveryManager: SessionRecoveryManager;
	editor: CustomEditor;
	messageView: MessageView;
	toolOutputView: ToolOutputView;
	chatContainer: Container;
	scrollContainer: ScrollContainer;
	startupContainer: Container;
	planView: PlanView;
	footer: FooterComponent;
	notificationView: NotificationView;
	clearActiveSkills?: () => void;
}

export interface SessionStateControllerCallbacks {
	refreshFooterHint: () => void;
	requestRender: () => void;
	clearEditor: () => void;
	setPlanHint: (hint: string | null) => void;
	isAgentRunning: () => boolean;
}

export interface SessionStateControllerOptions {
	deps: SessionStateControllerDeps;
	callbacks: SessionStateControllerCallbacks;
}

export class SessionStateController {
	private readonly deps: SessionStateControllerDeps;
	private readonly callbacks: SessionStateControllerCallbacks;

	constructor(options: SessionStateControllerOptions) {
		this.deps = options.deps;
		this.callbacks = options.callbacks;
	}

	renderInitialMessages(state: AgentState): void {
		this.deps.footer.updateState(state);
		this.deps.messageView.renderInitialMessages(state);

		for (const message of state.messages) {
			if (message.role === "user") {
				const textBlocks =
					typeof message.content === "string"
						? [{ type: "text" as const, text: message.content }]
						: message.content.filter(
								(c): c is { type: "text"; text: string } => c.type === "text",
							);
				const textContent = textBlocks.map((c) => c.text).join("");
				if (textContent && !textContent.startsWith("[Context compaction:")) {
					this.deps.editor.addToHistory(textContent);
				}
			}
		}

		this.callbacks.requestRender();
	}

	renderConversationView(): void {
		this.deps.chatContainer.clear();
		this.deps.scrollContainer.clearHistory();
		this.deps.toolOutputView.clearTrackedComponents();
		this.deps.messageView.renderInitialMessages(this.deps.agent.state);
	}

	handleNewChatCommand(context: CommandExecutionContext): void {
		if (this.callbacks.isAgentRunning()) {
			context.showError(
				"Wait for the current run to finish before starting a new chat.",
			);
			return;
		}
		this.resetConversation([], undefined, "Started a new chat session.");
	}

	handleSessionRecoverCommand(context: CommandExecutionContext): void {
		const backups = listSessionBackups();
		if (!backups.length) {
			context.showInfo("No session backups available to recover.");
			return;
		}

		const cwd = process.cwd();
		const backup =
			backups.find((b) => b.cwd === cwd) ??
			backups.sort(
				(a, b) =>
					new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
			)[0];

		if (!backup) {
			context.showInfo("No session backups available to recover.");
			return;
		}

		this.resetConversation(
			backup.messages,
			undefined,
			`Recovered session ${backup.sessionId.slice(0, 8)} from backup.`,
			{ persistMessages: true },
		);
		this.deps.sessionRecoveryManager.markRecovered("manual_recovery");
	}

	resetConversation(
		messages: AppMessage[],
		editorSeed?: string,
		toastMessage?: string,
		options?: { preserveSession?: boolean; persistMessages?: boolean },
	): void {
		if (!options?.preserveSession) {
			this.deps.sessionManager.startFreshSession();
		}
		this.deps.agent.clearMessages();
		this.deps.sessionContext.resetArtifacts();
		this.deps.clearActiveSkills?.();
		this.deps.toolOutputView.clearTrackedComponents();
		this.deps.chatContainer.clear();
		this.deps.scrollContainer.clearHistory();
		this.deps.startupContainer.clear();
		this.deps.planView.syncHintWithStore();
		this.callbacks.setPlanHint(null);
		for (const message of messages) {
			this.deps.agent.appendMessage(message);
			if (options?.persistMessages) {
				this.deps.sessionManager.saveMessage(message);
			}
		}
		this.deps.footer.updateState(this.deps.agent.state);
		this.callbacks.refreshFooterHint();
		this.renderInitialMessages(this.deps.agent.state);
		if (editorSeed !== undefined) {
			this.deps.editor.setText(editorSeed);
		} else {
			this.callbacks.clearEditor();
		}
		if (toastMessage) {
			this.deps.notificationView.showToast(toastMessage, "success");
		}
	}

	applyLoadedSessionContext(): void {
		this.deps.sessionContext.resetArtifacts();
		const thinking = this.deps.sessionManager.loadThinkingLevel();
		if (thinking) {
			this.deps.agent.setThinkingLevel(thinking as ThinkingLevel);
		}
		const modelKey = this.deps.sessionManager.loadModel();
		if (modelKey) {
			const [provider, modelId] = modelKey.split("/");
			if (provider && modelId) {
				const nextModel = getRegisteredModels().find(
					(entry) => entry.provider === provider && entry.id === modelId,
				);
				if (nextModel) {
					this.deps.agent.setModel(nextModel);
				}
			}
		}
	}
}

export function createSessionStateController(
	options: SessionStateControllerOptions,
): SessionStateController {
	return new SessionStateController(options);
}
