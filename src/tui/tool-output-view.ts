import type { TUI } from "../tui-lib/index.js";
import type { ToolExecutionComponent } from "./tool-execution.js";

interface ToolOutputViewOptions {
	ui: TUI;
	showInfoMessage: (message: string) => void;
}

export class ToolOutputView {
	private readonly toolComponents = new Set<ToolExecutionComponent>();
	private compactToolOutputs = false;

	constructor(private readonly options: ToolOutputViewOptions) {}

	registerToolComponent(component: ToolExecutionComponent): void {
		this.toolComponents.add(component);
		component.setCollapsed(this.compactToolOutputs);
	}

	clearTrackedComponents(): void {
		this.toolComponents.clear();
	}

	getTrackedComponents(): Set<ToolExecutionComponent> {
		return this.toolComponents;
	}

	handleCompactToolsCommand(text: string): void {
		const parts = text.trim().split(/\s+/);
		let nextState = this.compactToolOutputs;
		if (parts.length === 1) {
			nextState = !nextState;
		} else {
			const arg = parts[1].toLowerCase();
			if (arg === "on" || arg === "true") {
				nextState = true;
			} else if (arg === "off" || arg === "false") {
				nextState = false;
			} else if (arg === "toggle") {
				nextState = !nextState;
			} else {
				this.options.showInfoMessage("Usage: /compact-tools [on|off|toggle]");
				return;
			}
		}
		this.compactToolOutputs = nextState;
		this.applyCompactModeToTools();
		this.options.showInfoMessage(
			nextState
				? "Tool outputs will collapse by default."
				: "Tool outputs will show full content.",
		);
	}

	private applyCompactModeToTools(): void {
		for (const component of this.toolComponents) {
			component.setCollapsed(this.compactToolOutputs);
		}
		this.options.ui.requestRender();
	}
}
