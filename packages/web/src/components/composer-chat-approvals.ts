import type {
	ComposerActionApprovalRequest,
	ComposerApprovalMode,
} from "@evalops/contracts";
import type { ApiClient, Session } from "../services/api-client.js";

type ToastType = "success" | "error" | "info";

type ComposerChatApprovalsClient = Pick<
	ApiClient,
	"getApprovalMode" | "submitApprovalDecision"
>;

type ApprovalContext = {
	currentSessionId: string | null;
	shareToken: string | null;
};

export type ComposerChatApprovalState = {
	pendingApprovalQueue: ComposerActionApprovalRequest[];
	approvalSubmitting: boolean;
	approvalMode: ComposerApprovalMode | null;
	approvalModeNotice: string | null;
};

export type ComposerApprovalStatusUpdate = {
	mode: ComposerApprovalMode;
	message?: string;
	notify?: boolean;
	sessionId?: string | null;
};

export class ComposerChatApprovals {
	private approvalModeNoticeSessionId: string | null = null;
	private approvalModeRequestId = 0;

	constructor(
		private readonly getApi: () => ComposerChatApprovalsClient,
		private readonly getState: () => ComposerChatApprovalState,
		private readonly setState: (
			state: Partial<ComposerChatApprovalState>,
		) => void,
		private readonly getContext: () => ApprovalContext,
		private readonly showToast: (
			message: string,
			type: ToastType,
			duration?: number,
		) => void,
	) {}

	readonly handleApproveRequest = (e: CustomEvent<{ requestId?: string }>) => {
		void this.submitDecision("approved", e.detail?.requestId);
	};

	readonly handleDenyRequest = (e: CustomEvent<{ requestId?: string }>) => {
		void this.submitDecision("denied", e.detail?.requestId);
	};

	enqueueRequest(request: ComposerActionApprovalRequest) {
		if (
			this.getState().pendingApprovalQueue.some(
				(entry) => entry.id === request.id,
			)
		) {
			return;
		}
		this.setState({
			pendingApprovalQueue: [...this.getState().pendingApprovalQueue, request],
		});
	}

	clearRequest(requestId: string) {
		this.setState({
			pendingApprovalQueue: this.getState().pendingApprovalQueue.filter(
				(request) => request.id !== requestId,
			),
		});
	}

	resetPendingRequests() {
		this.setState({
			pendingApprovalQueue: [],
			approvalSubmitting: false,
		});
	}

	restorePendingRequests(session: Pick<Session, "pendingApprovalRequests">) {
		this.setState({
			pendingApprovalQueue: Array.isArray(session.pendingApprovalRequests)
				? [...session.pendingApprovalRequests]
				: [],
			approvalSubmitting: false,
		});
	}

	getActiveRequest() {
		return this.getState().pendingApprovalQueue[0] ?? null;
	}

	getApprovalPillClass() {
		return this.getState().approvalMode === "auto"
			? "success"
			: this.getState().approvalMode === "fail"
				? "error"
				: "warning";
	}

	getApprovalTitle() {
		const { approvalMode, approvalModeNotice } = this.getState();
		return (
			approvalModeNotice ??
			(approvalMode ? `Approval mode: ${approvalMode}` : "Approval mode")
		);
	}

	clearModeStatus() {
		this.approvalModeRequestId += 1;
		this.approvalModeNoticeSessionId = null;
		this.setState({
			approvalMode: null,
			approvalModeNotice: null,
		});
	}

	updateModeStatus(options: ComposerApprovalStatusUpdate) {
		const sessionId = options.sessionId ?? this.getApprovalModeSessionId();
		if (
			this.getContext().shareToken ||
			sessionId !== this.getApprovalModeSessionId()
		) {
			return;
		}

		this.approvalModeRequestId += 1;
		const note =
			typeof options.message === "string" &&
			options.message.includes("server default is stricter")
				? options.message
				: null;

		this.approvalModeNoticeSessionId = sessionId;
		this.setState({
			approvalMode: options.mode,
			approvalModeNotice: note,
		});

		if (options.notify && options.message) {
			this.showToast(options.message, note ? "info" : "success", 2200);
		}
	}

	async loadModeStatus(sessionId = this.getApprovalModeSessionId()) {
		if (this.getContext().shareToken) {
			this.clearModeStatus();
			return;
		}

		const requestId = ++this.approvalModeRequestId;

		try {
			const status = await this.getApi().getApprovalMode(sessionId);
			if (
				requestId !== this.approvalModeRequestId ||
				this.getContext().shareToken ||
				sessionId !== this.getApprovalModeSessionId()
			) {
				return;
			}

			const nextState: Partial<ComposerChatApprovalState> = {
				approvalMode: status.mode,
			};
			if (this.approvalModeNoticeSessionId !== sessionId) {
				nextState.approvalModeNotice = null;
				this.approvalModeNoticeSessionId = sessionId;
			}
			this.setState(nextState);
		} catch (error) {
			if (
				requestId !== this.approvalModeRequestId ||
				this.getContext().shareToken ||
				sessionId !== this.getApprovalModeSessionId()
			) {
				return;
			}
			this.approvalModeNoticeSessionId = sessionId;
			this.setState({
				approvalMode: null,
				approvalModeNotice: null,
			});
			console.warn("Failed to load approval mode", error);
		}
	}

	async submitDecision(decision: "approved" | "denied", requestId?: string) {
		if (!requestId || this.getState().approvalSubmitting) {
			return;
		}

		this.setState({ approvalSubmitting: true });

		try {
			await this.getApi().submitApprovalDecision({ requestId, decision });
			this.clearRequest(requestId);
			this.showToast(
				decision === "approved" ? "Approval submitted" : "Denial submitted",
				decision === "approved" ? "success" : "info",
				1500,
			);
		} catch (error) {
			this.showToast(
				error instanceof Error
					? error.message
					: "Failed to submit approval decision",
				"error",
				2200,
			);
		} finally {
			this.setState({ approvalSubmitting: false });
		}
	}

	private getApprovalModeSessionId(): string {
		return this.getContext().currentSessionId ?? "default";
	}
}
