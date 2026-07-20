import type { Container, TUI } from "@evalops/tui";
import type { CustomEditor } from "../custom-editor.js";
import type { ModalManager } from "../modal-manager.js";
import type { NotificationView } from "../notification-view.js";
import { OAuthFlowController } from "../oauth/index.js";

export function createOAuthFlowController(params: {
	modalManager: ModalManager;
	notificationView: NotificationView;
	chatContainer: Container;
	ui: TUI;
	editor: CustomEditor;
	clearEditor: () => void;
}): OAuthFlowController {
	const {
		modalManager,
		notificationView,
		chatContainer,
		ui,
		editor,
		clearEditor,
	} = params;

	const editorRef = editor;
	return new OAuthFlowController({
		modalManager,
		notificationView,
		renderContext: {
			chatContainer,
			ui,
			requestRender: () => ui.requestRender(),
		},
		editorCallbacks: {
			clearEditor,
			getText: () => editorRef.getText(),
			setText: (text) => editorRef.setText(text),
			get onSubmit() {
				return editorRef.onSubmit;
			},
			set onSubmit(handler) {
				editorRef.onSubmit = handler;
			},
		},
	});
}
