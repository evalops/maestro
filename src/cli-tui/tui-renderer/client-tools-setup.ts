import type { Container, TUI } from "@evalops/tui";
import { ClientToolController } from "../client-tools/client-tool-controller.js";
import type { TuiClientToolService } from "../client-tools/local-client-tool-service.js";
import type { CustomEditor } from "../custom-editor.js";
import type { NotificationView } from "../notification-view.js";

export function createClientToolController(params: {
	clientToolService: TuiClientToolService;
	ui: TUI;
	editor: CustomEditor;
	editorContainer: Container;
	notificationView: NotificationView;
	onPendingStatusChange?: (toolCallId: string, status: string | null) => void;
}): ClientToolController {
	return new ClientToolController(params);
}
