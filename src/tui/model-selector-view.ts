import type { Agent } from "../agent/agent.js";
import type { SessionManager } from "../session-manager.js";
import type { RegisteredModel } from "../models/registry.js";
import type { Container, TUI } from "../tui-lib/index.js";
import { ModelSelectorComponent } from "./model-selector.js";
import type { CustomEditor } from "./custom-editor.js";

interface ModelSelectorViewOptions {
	agent: Agent;
	sessionManager: SessionManager;
	editor: CustomEditor;
	editorContainer: Container;
	ui: TUI;
	showInfoMessage: (text: string) => void;
}

export class ModelSelectorView {
	private selector: ModelSelectorComponent | null = null;

	constructor(private readonly options: ModelSelectorViewOptions) {}

	show(): void {
		if (this.selector) {
			return;
		}
		this.selector = new ModelSelectorComponent(
			this.options.agent.state.model as RegisteredModel,
			(model) => {
				this.options.agent.setModel(model);
				this.options.sessionManager.saveModelChange(
					`${model.provider}/${model.id}`,
				);
				this.options.showInfoMessage(`Model: ${model.id}`);
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
		this.options.ui.setFocus(this.selector);
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
