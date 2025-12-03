import type { TUI } from "@evalops/tui";
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
		const shouldCollapse =
			this.compactToolOutputs || component.prefersCollapsedByDefault();
		component.setCollapsed(shouldCollapse);
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

	setCompactMode(compact: boolean, silent = false): void {
		this.compactToolOutputs = compact;
		this.applyCompactModeToTools();
		if (!silent) {
			this.options.showInfoMessage(
				compact
					? "Tool outputs will collapse by default."
					: "Tool outputs will show full content.",
			);
		}
	}

	toggleCompactMode(): boolean {
		this.compactToolOutputs = !this.compactToolOutputs;
		this.applyCompactModeToTools();
		return this.compactToolOutputs;
	}

	isCompact(): boolean {
		return this.compactToolOutputs;
	}

	private applyCompactModeToTools(): void {
		for (const component of this.toolComponents) {
			const shouldCollapse =
				this.compactToolOutputs || component.prefersCollapsedByDefault();
			component.setCollapsed(shouldCollapse);
		}
		this.options.ui.requestRender();
	}
}
