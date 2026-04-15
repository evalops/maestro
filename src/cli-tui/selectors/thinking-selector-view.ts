import type { TUI } from "@evalops/tui";
import type { Agent } from "../../agent/agent.js";
import type { SessionManager } from "../../session/manager.js";
import type { ModalManager } from "../modal-manager.js";
import { ThinkingSelectorComponent } from "./thinking-selector.js";

interface ThinkingSelectorViewOptions {
	agent: Agent;
	sessionManager: SessionManager;
	modalManager: ModalManager;
	ui: TUI;
	showInfoMessage: (text: string) => void;
}

export class ThinkingSelectorView {
	private selector: ThinkingSelectorComponent | null = null;

	constructor(private readonly options: ThinkingSelectorViewOptions) {}

	show(): void {
		if (this.selector) {
			return;
		}
		this.selector = new ThinkingSelectorComponent(
			this.options.agent.state.thinkingLevel,
			(level) => {
				this.options.agent.setThinkingLevel(level);
				this.options.sessionManager.saveThinkingLevelChange(level);
				this.options.showInfoMessage(`Thinking level: ${level}`);
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
