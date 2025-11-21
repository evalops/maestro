import type { Container, TUI } from "@evalops/tui";
import type { CustomEditor } from "../custom-editor.js";
import type { NotificationView } from "../notification-view.js";
import { QueueModeSelectorComponent } from "./queue-mode-selector.js";

interface QueueModeSelectorViewOptions {
	editor: CustomEditor;
	editorContainer: Container;
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

		this.options.editorContainer.clear();
		this.options.editorContainer.addChild(this.selector);
		this.options.ui.setFocus(this.selector.getSelectList());
		this.options.ui.requestRender();
	}

	private hide(): void {
		if (!this.selector) {
			return;
		}
		this.options.editorContainer.clear();
		this.options.editorContainer.addChild(this.options.editor);
		this.selector = null;
		this.options.ui.setFocus(this.options.editor);
	}
}
