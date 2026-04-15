import type { Container, TUI } from "@evalops/tui";
import type { ToolRetryService } from "../../agent/tool-retry.js";
import type { CustomEditor } from "../custom-editor.js";
import type { NotificationView } from "../notification-view.js";
import { ToolRetryController } from "../tool-retry/tool-retry-controller.js";

export function createToolRetryController(params: {
	toolRetryService: ToolRetryService;
	ui: TUI;
	editor: CustomEditor;
	editorContainer: Container;
	notificationView: NotificationView;
}): ToolRetryController {
	return new ToolRetryController(params);
}
