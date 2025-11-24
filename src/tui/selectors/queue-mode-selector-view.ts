import type { TUI } from "@evalops/tui";
import type { ModalManager } from "../modal-manager.js";
import type { NotificationView } from "../notification-view.js";
import { QueueModeSelectorComponent } from "./queue-mode-selector.js";

interface QueueModeSelectorViewOptions {
	modalManager: ModalManager;
	ui: TUI;
	notificationView: NotificationView;
	onModeSelected: (mode: "all" | "one") => void;
}

export class QueueModeSelectorView {
	private selector: QueueModeSelectorComponent | null = null;

	constructor(private readonly options: QueueModeSelectorViewOptions) {}

	show(currentMode: "all" | "one"): void {
		if (this.selector) {
			return;
		}

		this.selector = new QueueModeSelectorComponent(
			currentMode,
			(mode) => {
				this.options.onModeSelected(mode);
				this.hide();
				this.options.ui.requestRender();
			},
			() => {
				this.hide();
				this.options.ui.requestRender();
			},
		);

		this.options.modalManager.push(this.selector);
	}

	private hide(): void {
		if (!this.selector) {
			return;
		}
		this.options.modalManager.pop();
		this.selector = null;
	}
}
