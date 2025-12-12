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
			onToggleMode: () => {
				const current = this.options.queueController.getMode();
				const next: QueueMode = current === "all" ? "one" : "all";
				this.options.queueController.setMode(next);
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
		const [action, idText] = args.split(/\s+/, 2);
		if (action === "mode") {
			const modeText = (idText ?? "").toLowerCase();
			if (!modeText) {
				this.options.queueModeSelectorView.show(
					this.options.queueController.getMode(),
				);
				return;
			}
			if (modeText !== "one" && modeText !== "all") {
				context.showError('Mode must be "one" or "all".');
				return;
			}
			this.options.queueController.setMode(modeText as QueueMode);
			return;
		}
		if (action === "cancel") {
			const id = Number.parseInt(idText ?? "", 10);
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
			this.options.queueController.getMode(),
		);
		this.options.modalManager.push(this.modal);
	}

	refreshPanel(): void {
		const snapshot = this.options.queueController.getSnapshot();
		this.modal.setData(
			snapshot.active ?? null,
			snapshot.pending,
			this.options.queueController.getMode(),
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
		const mode = this.options.queueController.getMode();
		const modeLabel =
			mode === "all"
				? "all (submissions enqueue while running)"
				: "one-at-a-time (submissions paused while running)";
		lines.push(`Mode: ${modeLabel}`);
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
				"Use /queue cancel <id> to remove a prompt. Use /queue mode <one|all> to change behavior.",
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
