import type { Container } from "../tui-lib/index.js";
import { Loader, type TUI } from "../tui-lib/index.js";
import type { FooterComponent } from "./footer.js";
import { LoaderStageManager } from "./loader-stage-manager.js";

interface LoaderViewOptions {
	ui: TUI;
	statusContainer: Container;
	footer: FooterComponent;
}

export class LoaderView {
	private loader: Loader | null = null;
	private stageManager: LoaderStageManager;

	constructor(private readonly options: LoaderViewOptions) {
		this.stageManager = new LoaderStageManager({
			setFooterStage: (label) => this.options.footer.setStage(label),
			onStageChanged: (label, index, total) => {
				if (this.loader) {
					this.loader.setStage(label, index, total);
				}
			},
			onProgressChanged: (value) => {
				if (this.loader) {
					this.loader.setProgress(value);
				}
			},
		});
	}

	start(): void {
		this.stop();
		this.loader = new Loader(this.options.ui, "Planning");
		this.loader.setHint("(esc to interrupt)");
		this.loader.setTitle("Active tasks");
		this.options.statusContainer.addChild(this.loader);
		this.stageManager.start();
	}

	stop(): void {
		if (this.loader) {
			this.loader.stop();
			this.loader = null;
		}
		this.options.statusContainer.clear();
		this.stageManager.stop();
	}

	setStreamingActive(active: boolean): void {
		this.stageManager.setStreamingActive(active);
	}

	maybeTransitionToResponding(): void {
		this.stageManager.maybeTransitionToResponding();
	}

	registerToolStage(toolCallId: string, toolName: string): void {
		if (!this.loader) return;
		this.stageManager.registerToolStage(toolCallId, toolName);
	}

	markToolComplete(toolCallId: string): void {
		this.stageManager.markToolComplete(toolCallId);
	}

	finish(): void {
		this.stageManager.finish();
		if (this.loader) {
			this.loader.stop();
			this.loader = null;
		}
		this.options.statusContainer.clear();
	}
}
