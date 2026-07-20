import type { Container, TUI } from "@evalops/tui";
import type { ActionApprovalService } from "../../agent/action-approval.js";
import { ApprovalController } from "../approval/approval-controller.js";
import type { CustomEditor } from "../custom-editor.js";
import type { NotificationView } from "../notification-view.js";

export function createApprovalController(params: {
	approvalService: ActionApprovalService;
	ui: TUI;
	editor: CustomEditor;
	editorContainer: Container;
	notificationView: NotificationView;
}): ApprovalController {
	return new ApprovalController(params);
}
