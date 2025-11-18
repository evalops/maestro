import type { Container, TUI } from "../tui-lib/index.js";
import type { CustomEditor } from "./custom-editor.js";
import { ReportSelectorComponent, type ReportType } from "./report-selector.js";

interface ReportSelectorViewOptions {
	editor: CustomEditor;
	editorContainer: Container;
	ui: TUI;
	onSelect: (type: ReportType) => void;
}

export class ReportSelectorView {
	private selector: ReportSelectorComponent | null = null;

	constructor(private readonly options: ReportSelectorViewOptions) {}

	show(): void {
		if (this.selector) {
			return;
		}
		this.selector = new ReportSelectorComponent(
			(type) => {
				this.hide();
				this.options.onSelect(type);
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

export type { ReportType };
