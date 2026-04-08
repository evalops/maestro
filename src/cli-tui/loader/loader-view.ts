import type { Container } from "@evalops/tui";
import { Loader, Spacer, type TUI } from "@evalops/tui";
import type { FooterComponent } from "../footer.js";
import { getLoaderTip } from "../tips/tip-scheduler.js";
import {
	STAGE_DISPLAY_LABELS,
	detectStageKind,
} from "../utils/stage-labels.js";
import { LoaderStageManager } from "./loader-stage-manager.js";

interface LoaderViewOptions {
	ui: TUI;
	statusContainer: Container;
	footer: FooterComponent;
	lowColor?: boolean;
	lowUnicode?: boolean;
	disableAnimations?: boolean;
	onLayoutChange?: () => void;
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
			setFooterStage: (label) => {
				this.options.footer.setStage(label);
			},
			setFooterHint: (hint) => this.options.footer.setHint(hint),
			selectDreamingHint: () => getLoaderTip(),
			onStageChanged: (label, index, total) => {
				this.handleStageChanged(label, index, total);
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
		this.mountLoader(STAGE_DISPLAY_LABELS.thinking);
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
		this.stageManager.start();
		this.hasActiveTurn = true;
	}

	completeTurn(): void {
		if (!this.hasActiveTurn) {
			return;
		}
		this.stageManager.completeTurn();
		this.hasActiveTurn = false;
		if (this.loader) {
			this.loader.stop();
			this.loader = null;
			this.setIdlePlaceholder();
		}
	}

	setStreamingActive(active: boolean): void {
		this.stageManager.setStreamingActive(active);
	}

	maybeTransitionToResponding(): void {
		this.stageManager.maybeTransitionToResponding();
	}

	registerToolStage(
		toolCallId: string,
		toolName: string,
		args: Record<string, unknown> = {},
		summaryLabel?: string,
	): void {
		this.stageManager.registerToolStage(
			toolCallId,
			toolName,
			args,
			summaryLabel,
		);
	}

	markToolComplete(toolCallId: string): void {
		this.stageManager.markToolComplete(toolCallId);
	}

	showRuntimeStatus(status: string, details?: Record<string, unknown>): void {
		const normalized = status.trim();
		if (!normalized) {
			return;
		}
		this.options.footer.setToast(
			normalized === "compacting"
				? "Compacting conversation..."
				: details?.kind === "tool_execution_summary" ||
						details?.kind === "token_budget_continuation"
					? normalized
					: `Status: ${normalized}`,
			"info",
			4500,
		);
	}

	showCompactionNotice(auto = false): void {
		this.options.footer.setToast(
			auto ? "Compacted conversation automatically" : "Compacted conversation",
			"success",
			4500,
		);
	}

	showRuntimeError(message: string): void {
		const normalized = message.trim();
		if (!normalized) {
			return;
		}
		this.options.footer.setToast(normalized, "danger");
	}

	showToolBatchSummary(summary: string): void {
		this.options.footer.setToast(summary, "info", 4500);
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
		this.options.onLayoutChange?.();
	}

	private clearStatus(): void {
		this.options.statusContainer.clear();
	}

	private handleStageChanged(
		label: string,
		index: number,
		total: number,
	): void {
		if (this.isRespondingLabel(label)) {
			this.hideLoaderForResponding();
			return;
		}
		if (!this.loader) {
			this.mountLoader(label);
		}
		this.loader?.setStage(label, index, total);
	}

	private hideLoaderForResponding(): void {
		if (this.loader) {
			this.loader.stop();
			this.loader = null;
		}
		this.setIdlePlaceholder();
	}

	private isRespondingLabel(label: string): boolean {
		return detectStageKind(label) === "responding";
	}

	private mountLoader(initialStage: string): void {
		if (this.loader) {
			this.loader.stop();
		}
		this.clearStatus();
		this.loader = new Loader(this.options.ui, initialStage, {
			mode: "compact",
			lowColor: this.options.lowColor,
			lowUnicode: this.options.lowUnicode,
			animate: !this.options.disableAnimations,
		});
		this.options.statusContainer.addChild(this.loader);
		this.options.onLayoutChange?.();
	}
}
