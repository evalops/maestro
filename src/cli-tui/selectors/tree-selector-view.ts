import { Spacer, type TUI, Text } from "@evalops/tui";
import type { Agent } from "../../agent/agent.js";
import { buildBranchSummaryPrompt } from "../../agent/branch-summary.js";
import { buildLocalSummary } from "../../agent/compaction.js";
import { convertAppMessagesToLlm } from "../../agent/custom-messages.js";
import type { ThinkingLevel } from "../../agent/types.js";
import type { AppMessage, Message } from "../../agent/types.js";
import {
	createRenderableMessage,
	renderMessageToPlainText,
} from "../../conversation/render-model.js";
import { getRegisteredModels } from "../../models/registry.js";
import {
	buildBranchSummaryMessages,
	collectEntriesForBranchSummary,
} from "../../session/branch-summary.js";
import type { SessionManager } from "../../session/manager.js";
import type { SessionTreeEntry } from "../../session/types.js";
import { theme } from "../../theme/theme.js";
import { createLogger } from "../../utils/logger.js";
import type { CustomEditor } from "../custom-editor.js";
import { HookInputModal } from "../hooks/hook-input-modal.js";
import type { ModalManager } from "../modal-manager.js";
import type { NotificationView } from "../notification-view.js";
import { BaseSelectorComponent } from "./base-selector.js";
import { TreeSelectorComponent } from "./tree-selector.js";

interface TreeSelectorViewOptions {
	agent: Agent;
	sessionManager: SessionManager;
	editor: CustomEditor;
	modalManager: ModalManager;
	ui: TUI;
	notificationView: NotificationView;
	onNavigated: () => void;
}

const logger = createLogger("tui:tree-selector");

function extractUserText(message: {
	content: string | { type: string; text?: string }[];
}): string {
	if (typeof message.content === "string") {
		return message.content.trim();
	}
	if (Array.isArray(message.content)) {
		return message.content
			.filter(
				(block) => block.type === "text" && typeof block.text === "string",
			)
			.map((block) => block.text)
			.join("\n")
			.trim();
	}
	return "";
}

function getVisibleLeafId(sessionManager: SessionManager): string | null {
	let visibleLeafId = sessionManager.getLeafId();
	while (visibleLeafId) {
		const entry = sessionManager.getEntry(visibleLeafId);
		if (!entry) break;
		if (entry.type !== "label" && entry.type !== "custom") {
			break;
		}
		visibleLeafId = entry.parentId ?? null;
	}
	return visibleLeafId;
}

export class TreeSelectorView {
	private selector: TreeSelectorComponent | null = null;
	private labelModalOpen = false;

	constructor(private readonly options: TreeSelectorViewOptions) {}

	private confirmBranchSummary(): Promise<boolean> {
		return new Promise((resolve) => {
			const items = [
				{ label: "Yes", value: "yes" },
				{ label: "No", value: "no" },
			];
			const selector = new BaseSelectorComponent({
				items,
				visibleRows: 2,
				onSelect: (value) => {
					this.options.modalManager.pop();
					resolve(value === "yes");
				},
				onCancel: () => {
					this.options.modalManager.pop();
					resolve(false);
				},
				prepend: [
					new Text(theme.fg("accent", "Summarize branch?"), 1, 0),
					new Text(
						theme.fg("muted", "Create a summary of the branch you're leaving?"),
						1,
						0,
					),
					new Spacer(1),
				],
			});
			this.options.modalManager.push(selector);
		});
	}

	private async generateBranchSummary(
		entries: SessionTreeEntry[],
	): Promise<{ summary: string; usedModel: boolean }> {
		const messages = buildBranchSummaryMessages(entries, 40);
		if (messages.length === 0) {
			return { summary: "No content to summarize.", usedModel: false };
		}

		let summaryText = "";
		let usedModel = false;

		try {
			const prompt = buildBranchSummaryPrompt();
			const llmMessages = convertAppMessagesToLlm(messages) as Message[];
			const summaryMessage = await this.options.agent.generateSummary(
				llmMessages,
				prompt,
				"You are a careful note-taker that distills coding conversations into actionable summaries.",
			);
			const summaryRenderable = createRenderableMessage(
				summaryMessage as AppMessage,
			);
			summaryText = summaryRenderable
				? renderMessageToPlainText(summaryRenderable).trim()
				: "";
			usedModel = summaryText.length > 0;
		} catch (error) {
			logger.warn("Branch summarization failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}

		if (!summaryText) {
			summaryText = buildLocalSummary(messages as AppMessage[], 32);
			usedModel = false;
		}

		return { summary: summaryText, usedModel };
	}

	show(): void {
		if (this.selector) {
			return;
		}

		const tree = this.options.sessionManager.getTree();
		const visibleLeafId = getVisibleLeafId(this.options.sessionManager);
		if (tree.length === 0) {
			this.options.notificationView.showInfo("No entries in session");
			return;
		}

		this.selector = new TreeSelectorComponent(
			tree,
			visibleLeafId,
			this.options.ui.getTerminalSize().rows,
			{
				onSelect: (entryId) => {
					void this.handleSelect(entryId, visibleLeafId);
				},
				onCancel: () => this.hide(),
				onLabelEdit: (entryId, label) => this.showLabelEditor(entryId, label),
			},
		);

		this.options.modalManager.push(this.selector);
	}

	private async handleSelect(
		entryId: string,
		visibleLeafId: string | null,
	): Promise<void> {
		if (entryId === visibleLeafId) {
			this.options.notificationView.showToast("Already at this point", "info");
			this.hide();
			return;
		}

		try {
			const oldLeafId =
				visibleLeafId ?? this.options.sessionManager.getLeafId();
			const targetEntry = this.options.sessionManager.getEntry(entryId);
			if (!targetEntry) {
				throw new Error(`Entry ${entryId} not found`);
			}

			const summaryPlan = collectEntriesForBranchSummary(
				this.options.sessionManager,
				oldLeafId,
				entryId,
			);

			this.hide();

			let summaryText: string | undefined;
			let usedModel = false;
			if (summaryPlan.entries.length > 0) {
				const wantsSummary = await this.confirmBranchSummary();
				if (wantsSummary) {
					this.options.notificationView.showToast(
						"Summarizing branch...",
						"info",
					);
					const summary = await this.generateBranchSummary(summaryPlan.entries);
					summaryText = summary.summary.trim();
					usedModel = summary.usedModel;
				}
			}

			let newLeafId: string | null = entryId;
			let editorText: string | undefined;
			if (
				targetEntry.type === "message" &&
				targetEntry.message.role === "user"
			) {
				newLeafId = targetEntry.parentId;
				editorText = extractUserText(targetEntry.message);
			} else if (targetEntry.type === "custom_message") {
				newLeafId = targetEntry.parentId;
				editorText = extractUserText({ content: targetEntry.content });
			} else if (
				targetEntry.type === "label" ||
				targetEntry.type === "custom"
			) {
				newLeafId = targetEntry.parentId;
			}

			if (summaryText) {
				this.options.sessionManager.branchWithSummary(newLeafId, summaryText, {
					fromId: oldLeafId ?? "root",
				});
			} else if (newLeafId === null) {
				this.options.sessionManager.resetLeaf();
			} else {
				this.options.sessionManager.branch(newLeafId);
			}

			const context = this.options.sessionManager.buildSessionContext();
			this.options.agent.replaceMessages(context.messages);
			if (context.thinkingLevel) {
				this.options.agent.setThinkingLevel(
					context.thinkingLevel as ThinkingLevel,
				);
			}
			if (context.model) {
				const [provider, modelId] = context.model.split("/");
				if (provider && modelId) {
					const nextModel = getRegisteredModels().find(
						(entry) => entry.provider === provider && entry.id === modelId,
					);
					if (nextModel) {
						this.options.agent.setModel(nextModel);
					}
				}
			}

			if (editorText) {
				this.options.editor.setText(editorText);
				this.options.ui.requestRender();
			}

			this.options.onNavigated();
			const navMessage = summaryText
				? usedModel
					? "Navigated to selected branch (summary added)."
					: "Navigated to selected branch (local summary added)."
				: "Navigated to selected branch";
			this.options.notificationView.showToast(navMessage, "success");
		} catch (error) {
			this.options.notificationView.showError(
				error instanceof Error ? error.message : String(error),
			);
			this.hide();
		}
	}

	private showLabelEditor(entryId: string, label?: string): void {
		if (!this.selector || this.labelModalOpen) {
			return;
		}
		this.labelModalOpen = true;
		const modal = new HookInputModal({
			ui: this.options.ui,
			title: "Edit label",
			description: "Leave empty to clear the label.",
			prefill: label ?? "",
			onSubmit: (value) => {
				const trimmed = value.trim();
				try {
					this.options.sessionManager.appendLabel(
						entryId,
						trimmed.length > 0 ? trimmed : undefined,
					);
					this.selector?.updateLabel(entryId, trimmed || undefined);
					this.options.notificationView.showToast(
						trimmed ? "Label updated" : "Label cleared",
						"success",
					);
				} catch (error) {
					this.options.notificationView.showError(
						error instanceof Error ? error.message : String(error),
					);
				}
				this.closeLabelModal();
			},
			onCancel: () => this.closeLabelModal(),
		});
		this.options.modalManager.push(modal);
	}

	private closeLabelModal(): void {
		if (!this.labelModalOpen) return;
		this.options.modalManager.pop();
		this.labelModalOpen = false;
		if (this.selector) {
			this.options.ui.setFocus(this.selector.getTreeList());
		}
	}

	private hide(): void {
		if (!this.selector) {
			return;
		}
		if (this.labelModalOpen) {
			this.options.modalManager.pop();
			this.labelModalOpen = false;
		}
		this.options.modalManager.pop();
		this.selector = null;
	}
}
