import type { Container, TUI } from "@evalops/tui";
import type {
	ToolRetryDecision,
	ToolRetryRequest,
	ToolRetryService,
} from "../../agent/tool-retry.js";
import type { CustomEditor } from "../custom-editor.js";
import type { NotificationView } from "../notification-view.js";
import { ToolRetryModal } from "./tool-retry-modal.js";

interface ToolRetryControllerOptions {
	toolRetryService: ToolRetryService;
	ui: TUI;
	editor: CustomEditor;
	editorContainer: Container;
	notificationView: NotificationView;
}

export class ToolRetryController {
	private queue: ToolRetryRequest[] = [];
	private active: ToolRetryRequest | null = null;
	private modal: ToolRetryModal | null = null;
	private processingNext = false;

	constructor(private readonly options: ToolRetryControllerOptions) {}

	enqueue(request: ToolRetryRequest): void {
		if (this.active?.id === request.id) {
			return;
		}
		if (this.queue.find((entry) => entry.id === request.id)) {
			return;
		}
		this.queue.push(request);
		if (this.active) {
			this.modal?.setQueueSize(this.queue.length);
			this.options.ui.requestRender();
			return;
		}
		this.scheduleNext();
	}

	resolve(request: ToolRetryRequest, decision: ToolRetryDecision): void {
		if (this.active?.id === request.id) {
			this.active = null;
		} else {
			this.queue = this.queue.filter((entry) => entry.id !== request.id);
		}
		const tone: "success" | "warn" =
			decision.action === "retry" ? "success" : "warn";
		const message =
			decision.action === "retry"
				? "Retrying tool"
				: decision.action === "abort"
					? "Aborted run"
					: "Skipped tool retry";
		this.options.notificationView.showToast(message, tone);
		this.scheduleNext();
	}

	private scheduleNext(): void {
		if (this.processingNext) return;
		this.processingNext = true;
		queueMicrotask(() => {
			this.processingNext = false;
			this.showNext();
		});
	}

	private showNext(): void {
		if (this.queue.length === 0) {
			this.active = null;
			this.restoreEditor();
			return;
		}
		const next = this.queue.shift();
		if (!next) {
			return;
		}
		this.active = next;
		const modal = new ToolRetryModal({
			request: next,
			queueSize: this.queue.length,
			onRetry: () => this.handleRetry(),
			onSkip: () => this.handleSkip(),
			onAbort: () => this.handleAbort(),
			onCancel: () => this.handleSkip(),
		});
		this.modal = modal;
		this.options.editorContainer.clear();
		this.options.editorContainer.addChild(modal);
		this.options.ui.setFocus(modal);
		this.options.ui.requestRender();
	}

	private handleRetry(): void {
		if (!this.active) return;
		const updated = this.options.toolRetryService.retry(
			this.active.id,
			"Retrying in TUI",
		);
		if (!updated) {
			this.options.notificationView.showError(
				"Unable to retry – request already resolved.",
			);
		}
	}

	private handleSkip(): void {
		if (!this.active) return;
		const updated = this.options.toolRetryService.skip(
			this.active.id,
			"Skipped in TUI",
		);
		if (!updated) {
			this.options.notificationView.showError(
				"Unable to skip – request already resolved.",
			);
		}
	}

	private handleAbort(): void {
		if (!this.active) return;
		const updated = this.options.toolRetryService.abort(
			this.active.id,
			"Aborted in TUI",
		);
		if (!updated) {
			this.options.notificationView.showError(
				"Unable to abort – request already resolved.",
			);
		}
	}

	private restoreEditor(): void {
		if (!this.modal) {
			return;
		}
		this.options.editorContainer.clear();
		this.options.editorContainer.addChild(this.options.editor);
		this.options.ui.setFocus(this.options.editor);
		this.modal = null;
		this.options.ui.requestRender();
	}
}
