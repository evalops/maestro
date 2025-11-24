import type { TUI } from "@evalops/tui";
import type { Agent } from "../../agent/agent.js";
import type { RegisteredModel } from "../../models/registry.js";
import type { SessionManager } from "../../session/manager.js";
import type { ModalManager } from "../modal-manager.js";
import { ModelSelectorComponent } from "./model-selector.js";

interface ModelSelectorViewOptions {
	agent: Agent;
	sessionManager: SessionManager;
	modalManager: ModalManager;
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
		this.options.modalManager.push(this.selector);
	}

	private hide(): void {
		if (!this.selector) {
			return;
		}
		this.options.modalManager.pop();
		this.selector = null;
	}
}
