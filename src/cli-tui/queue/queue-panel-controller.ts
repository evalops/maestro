import { type Container, Spacer, type TUI, Text } from "@evalops/tui";
import type { CommandExecutionContext } from "../commands/types.js";
import type { ModalManager } from "../modal-manager.js";
import type { NotificationView } from "../notification-view.js";
import { QueuePanelModal } from "../queue-panel-modal.js";
import type { QueueModeSelectorView } from "../selectors/queue-mode-selector-view.js";
import type { QueueController, QueueMode } from "./queue-controller.js";

export interface QueuePanelControllerOptions {
	queueController: QueueController;
	modalManager: ModalManager;
	ui: TUI;
	notificationView: NotificationView;
	queueModeSelectorView: QueueModeSelectorView;
	chatContainer: Container;
}

/**
 * UI controller for the prompt queue modal + slash command surface.
 *
 * Keeps modal lifecycle and argument parsing out of TuiRenderer.
 */
export class QueuePanelController {
	private readonly modal: QueuePanelModal;

	constructor(private readonly options: QueuePanelControllerOptions) {
		this.modal = new QueuePanelModal({
			onClose: () => {
				this.options.modalManager.pop();
			},
			onCancel: (id) => {
				if (!this.options.queueController.hasQueue()) return;
				const removed = this.options.queueController.cancel(id);
				if (removed) {
					this.options.notificationView.showToast(
						`Cancelled queued prompt #${id}`,
						"success",
					);
					this.refreshPanel();
				}
			},
			onToggleFollowUpMode: () => {
				const current = this.options.queueController.getFollowUpMode();
				const next: QueueMode = current === "all" ? "one" : "all";
				this.options.queueController.setMode("followUp", next);
				this.refreshPanel();
			},
			onToggleSteeringMode: () => {
				const current = this.options.queueController.getSteeringMode();
				const next: QueueMode = current === "all" ? "one" : "all";
				this.options.queueController.setMode("steering", next);
				this.refreshPanel();
			},
		});
	}

	handleQueueCommand(context: CommandExecutionContext): void {
		if (!this.options.queueController.hasQueue()) {
			context.showInfo("Prompt queue is not available.");
			return;
		}
		const args = context.argumentText.trim();
		if (!args || args === "list") {
			this.showPanel();
			return;
		}
		const [action, scopeText, valueText] = args.split(/\s+/, 3);
		if (action === "mode") {
			const scope =
				(scopeText ?? "").toLowerCase() || (valueText ? "followup" : "");
			const normalizedScope =
				scope === "steer" || scope === "steering"
					? "steering"
					: scope === "followup" || scope === "follow-up"
						? "followUp"
						: null;
			const modeText = normalizedScope
				? (valueText ?? "").toLowerCase()
				: scope;
			if (!modeText) {
				const targetKind =
					normalizedScope === "steering" ? "steering" : "followUp";
				this.options.queueModeSelectorView.show(
					normalizedScope === "steering"
						? this.options.queueController.getSteeringMode()
						: this.options.queueController.getFollowUpMode(),
					targetKind,
				);
				return;
			}
			if (modeText !== "one" && modeText !== "all") {
				context.showError('Mode must be "one" or "all".');
				return;
			}
			if (normalizedScope === "steering") {
				this.options.queueController.setMode("steering", modeText as QueueMode);
				return;
			}
			if (normalizedScope === "followUp" || !normalizedScope) {
				this.options.queueController.setMode("followUp", modeText as QueueMode);
				return;
			}
			context.showError("Usage: /queue mode [steer|followup] <one|all>");
			return;
		}
		if (action === "cancel") {
			const id = Number.parseInt(scopeText ?? "", 10);
			if (!Number.isFinite(id)) {
				context.showError("Provide a numeric prompt id to cancel.");
				return;
			}
			const removed = this.options.queueController.cancel(id);
			if (!removed) {
				context.showError(`No queued prompt #${id} to cancel.`);
				return;
			}
			this.options.notificationView.showToast(
				`Cancelled queued prompt #${id}`,
				"success",
			);
			this.refreshPanel();
			return;
		}
		context.renderHelp();
	}

	showPanel(): void {
		const snapshot = this.options.queueController.getSnapshot();
		this.modal.setData(
			snapshot.active ?? null,
			snapshot.pending,
			this.options.queueController.getSteeringMode(),
			this.options.queueController.getFollowUpMode(),
			this.options.queueController.getNextSteeringBatchSummary(),
			this.options.queueController.getNextFollowUpBatchSummary(),
		);
		this.options.modalManager.push(this.modal);
	}

	refreshPanel(): void {
		const snapshot = this.options.queueController.getSnapshot();
		this.modal.setData(
			snapshot.active ?? null,
			snapshot.pending,
			this.options.queueController.getSteeringMode(),
			this.options.queueController.getFollowUpMode(),
			this.options.queueController.getNextSteeringBatchSummary(),
			this.options.queueController.getNextFollowUpBatchSummary(),
		);
		if (this.options.modalManager.getActiveModal() === this.modal) {
			this.options.ui.requestRender();
		}
	}

	/**
	 * Legacy chat rendering for queue state.
	 * Currently unused but kept for parity with help/diagnostics surfaces.
	 */
	renderQueueList(): void {
		if (!this.options.queueController.hasQueue()) {
			return;
		}
		const snapshot = this.options.queueController.getSnapshot();
		const lines: string[] = [];
		const followUpMode = this.options.queueController.getFollowUpMode();
		const steeringMode = this.options.queueController.getSteeringMode();
		const followUpLabel =
			followUpMode === "all"
				? "all (follow-ups can queue while running)"
				: "one-at-a-time (follow-ups pause while running)";
		const steeringLabel =
			steeringMode === "all"
				? "all (steering can queue while running)"
				: "one-at-a-time (steering pauses while running)";
		lines.push(`Follow-up mode: ${followUpLabel}`);
		lines.push(`Steering mode: ${steeringLabel}`);
		const nextSteeringBatch =
			this.options.queueController.getNextSteeringBatchSummary();
		if (nextSteeringBatch) {
			lines.push(`Next steering batch: ${nextSteeringBatch}`);
		}
		const nextFollowUpBatch =
			this.options.queueController.getNextFollowUpBatchSummary();
		if (nextFollowUpBatch) {
			lines.push(`Next follow-up batch: ${nextFollowUpBatch}`);
		}
		if (snapshot.active) {
			lines.push(
				`Active: #${snapshot.active.id} – ${this.formatQueuedText(snapshot.active.text)}`,
			);
		}
		if (snapshot.pending.length === 0) {
			lines.push("No queued prompts.");
		} else {
			lines.push("Pending prompts:");
			snapshot.pending.forEach((entry, index) => {
				lines.push(
					`${index + 1}. #${entry.id} – ${this.formatQueuedText(entry.text)}`,
				);
			});
			lines.push(
				"Use /queue cancel <id> to remove a prompt. Use /queue mode [steer|followup] <one|all> to change behavior.",
			);
		}
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(lines.join("\n"), 1, 0));
		this.options.ui.requestRender();
	}

	private formatQueuedText(message: string, maxLength = 80): string {
		const singleLine = message.replace(/\s+/g, " ").trim();
		if (singleLine.length <= maxLength) {
			return singleLine || "(empty message)";
		}
		return `${singleLine.slice(0, Math.max(0, maxLength - 1))}…`;
	}
}
