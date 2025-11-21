import type { Container } from "@evalops/tui";
import { Loader, Spacer, type TUI } from "@evalops/tui";
import type { FooterComponent } from "../footer.js";
import { LoaderStageManager } from "./loader-stage-manager.js";

interface LoaderViewOptions {
	ui: TUI;
	statusContainer: Container;
	footer: FooterComponent;
}

export class LoaderView {
	private loader: Loader | null = null;
	private stageManager: LoaderStageManager;
	private hasActiveTurn = false;
	private idlePlaceholder: Spacer;

	constructor(private readonly options: LoaderViewOptions) {
		// Keep a permanent spacer so the status row height stays fixed (prevents
		// cursor jumps in remote terminals when loader mounts/unmounts).
		// This is intentionally stateful (vs. inline Spacer creation) to ensure
		// a consistent node is reused across loader lifecycles.
		this.idlePlaceholder = new Spacer(1);
		this.setIdlePlaceholder();
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
		// If start is called back-to-back, stop any prior loader instance to avoid leaks.
		if (this.loader) {
			this.loader.stop();
			this.loader = null;
		}
		if (this.hasActiveTurn) {
			// Hard reset any dangling turn to avoid leaking stage state.
			this.stageManager.completeTurn();
			this.hasActiveTurn = false;
		}
		this.stageManager.stop();
		this.clearStatus();
		this.loader = new Loader(this.options.ui, "Planning");
		this.loader.setHint("(esc to interrupt)");
		this.loader.setTitle("Active tasks");
		this.options.statusContainer.addChild(this.loader);
		this.stageManager.start();
		this.hasActiveTurn = true;
	}

	stop(): void {
		if (this.loader) {
			this.loader.stop();
			this.loader = null;
		}
		this.hasActiveTurn = false;
		this.setIdlePlaceholder();
		this.stageManager.stop();
	}

	beginTurn(): void {
		if (!this.loader) {
			return;
		}
		this.stageManager.start();
		this.hasActiveTurn = true;
	}

	completeTurn(): void {
		if (!this.loader || !this.hasActiveTurn) {
			return;
		}
		this.stageManager.completeTurn();
		this.hasActiveTurn = false;
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
		this.hasActiveTurn = false;
		this.setIdlePlaceholder();
	}

	private setIdlePlaceholder(): void {
		this.clearStatus();
		this.options.statusContainer.addChild(this.idlePlaceholder);
	}

	private clearStatus(): void {
		this.options.statusContainer.clear();
	}
}
