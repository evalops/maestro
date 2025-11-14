import type { Agent } from "../agent/agent.js";
import type { SessionManager } from "../session-manager.js";
import type { Container, TUI } from "../tui-lib/index.js";
import type { CustomEditor } from "./custom-editor.js";
import { ThinkingSelectorComponent } from "./thinking-selector.js";

interface ThinkingSelectorViewOptions {
	agent: Agent;
	sessionManager: SessionManager;
	editor: CustomEditor;
	editorContainer: Container;
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
