import type { Container, TUI } from "@evalops/tui";
import type {
	ActionApprovalDecision,
	ActionApprovalRequest,
	ActionApprovalService,
} from "../../agent/action-approval.js";
import type { CustomEditor } from "../custom-editor.js";
import type { NotificationView } from "../notification-view.js";
import { ApprovalModal } from "./approval-modal.js";

interface ApprovalControllerOptions {
	approvalService: ActionApprovalService;
	ui: TUI;
	editor: CustomEditor;
	editorContainer: Container;
	notificationView: NotificationView;
}

export class ApprovalController {
	private queue: ActionApprovalRequest[] = [];
	private active: ActionApprovalRequest | null = null;
	private modal: ApprovalModal | null = null;
	private processingNext = false;

	constructor(private readonly options: ApprovalControllerOptions) {}

	enqueue(request: ActionApprovalRequest): void {
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

	resolve(
		request: ActionApprovalRequest,
		decision: ActionApprovalDecision,
	): void {
		if (this.active?.id === request.id) {
			this.active = null;
		} else {
			this.queue = this.queue.filter((entry) => entry.id !== request.id);
		}
		const tone: "success" | "warn" = decision.approved ? "success" : "warn";
		const message = decision.approved
			? "Approved high-risk action"
			: "Denied high-risk action";
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
		const modal = new ApprovalModal({
			request: next,
			queueSize: this.queue.length,
			onApprove: () => this.handleApprove(),
			onDeny: () => this.handleDeny(),
			onCancel: () => this.handleDeny(),
		});
		this.modal = modal;
		this.options.editorContainer.clear();
		this.options.editorContainer.addChild(modal);
		this.options.ui.setFocus(modal);
		this.options.ui.requestRender();
	}

	private handleApprove(): void {
		if (!this.active) return;
		const updated = this.options.approvalService.approve(
			this.active.id,
			"Approved in TUI",
		);
		if (!updated) {
			this.options.notificationView.showError(
				"Unable to approve – request already resolved.",
			);
		}
	}

	private handleDeny(): void {
		if (!this.active) return;
		const updated = this.options.approvalService.deny(
			this.active.id,
			"Denied in TUI",
		);
		if (!updated) {
			this.options.notificationView.showError(
				"Unable to deny – request already resolved.",
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
