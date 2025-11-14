import type { Container } from "../tui-lib/index.js";
import { Loader, TUI } from "../tui-lib/index.js";
import type { FooterComponent } from "./footer.js";
import { recordLoaderStage } from "../telemetry.js";

interface LoaderStageEntry {
	key: string;
	label: string;
}

interface LoaderViewOptions {
	ui: TUI;
	statusContainer: Container;
	footer: FooterComponent;
	telemetryEnabled: boolean;
}

export class LoaderView {
	private loader: Loader | null = null;
	private stages: LoaderStageEntry[] = [];
	private toolStageMeta = new Map<string, { toolName: string }>();
	private toolStagesByName = new Map<string, string[]>();
	private completedToolStages = new Set<string>();
	private completedStageKeys = new Set<string>();
	private currentStageKey: string | null = null;
	private stageStartTime: number | null = null;
	private streamingActive = false;

	constructor(private readonly options: LoaderViewOptions) {}

	start(): void {
		this.stop();
		this.resetTracking();
		this.loader = new Loader(this.options.ui, "Planning");
		this.loader.setHint("(esc to interrupt)");
		this.loader.setTitle("Active tasks");
		this.options.statusContainer.addChild(this.loader);
		this.updateStage("planning");
	}

	stop(): void {
		if (this.loader) {
			this.loader.stop();
			this.loader = null;
		}
		this.options.statusContainer.clear();
		this.clearTracking();
	}

	setStreamingActive(active: boolean): void {
		this.streamingActive = active;
	}

	maybeTransitionToResponding(): void {
		if (!this.loader) return;
		const noToolStages = this.toolStageMeta.size === 0;
		const allComplete =
			this.toolStageMeta.size > 0 &&
			this.completedToolStages.size === this.toolStageMeta.size;
		if (noToolStages || allComplete) {
			this.updateStage("responding");
		}
	}

	registerToolStage(toolCallId: string, toolName: string): void {
		if (!this.loader) return;
		if (this.toolStageMeta.has(toolCallId)) {
			this.updateStage(toolCallId);
			return;
		}
		this.toolStageMeta.set(toolCallId, { toolName });
		const respondingIndex = this.stages.findIndex(
			(stage) => stage.key === "responding",
		);
		const insertIndex = respondingIndex === -1 ? this.stages.length : respondingIndex;
		this.stages.splice(insertIndex, 0, {
			key: toolCallId,
			label: `Tool · ${toolName}`,
		});
		const group = this.toolStagesByName.get(toolName) ?? [];
		group.push(toolCallId);
		this.toolStagesByName.set(toolName, group);
		this.refreshToolStageLabels(toolName);
		this.updateStage(toolCallId);
	}

	markToolComplete(toolCallId: string): void {
		this.completedToolStages.add(toolCallId);
		this.completedStageKeys.add(toolCallId);
		this.refreshProgress();
		this.maybeTransitionToResponding();
	}

	finish(): void {
		if (this.loader) {
			if (this.currentStageKey) {
				this.completedStageKeys.add(this.currentStageKey);
				this.refreshProgress();
				this.loader.setProgress(1);
			}
			this.loader.stop();
			this.loader = null;
		}
		this.options.statusContainer.clear();
		this.clearTracking();
	}

	private resetTracking(): void {
		this.finalizeStageTiming();
		this.stages = [
			{ key: "planning", label: "Planning" },
			{ key: "responding", label: "Responding" },
		];
		this.toolStageMeta.clear();
		this.toolStagesByName.clear();
		this.completedToolStages.clear();
		this.completedStageKeys.clear();
		this.currentStageKey = null;
		this.stageStartTime = null;
		this.options.footer.setStage(null);
	}

	private clearTracking(): void {
		this.finalizeStageTiming();
		this.stages = [];
		this.toolStageMeta.clear();
		this.toolStagesByName.clear();
		this.completedToolStages.clear();
		this.completedStageKeys.clear();
		this.currentStageKey = null;
		this.stageStartTime = null;
		this.options.footer.setStage(null);
		if (this.loader) {
			this.loader.setProgress(null);
		}
	}

	private updateStage(key: string, labelOverride?: string): void {
		if (!this.loader) return;
		const now = Date.now();
		const stageChanged = this.currentStageKey !== key;
		if (stageChanged && this.currentStageKey && this.stageStartTime) {
			this.recordStageTiming(this.currentStageKey, now - this.stageStartTime);
		}
		const previousStageKey = stageChanged ? this.currentStageKey : null;
		let index = this.stages.findIndex((stage) => stage.key === key);
		if (index === -1) {
			const label = labelOverride ?? this.formatStageLabel(key);
			this.stages.push({ key, label });
			index = this.stages.length - 1;
		} else if (labelOverride) {
			this.stages[index].label = labelOverride;
		}
		if (previousStageKey) {
			this.completedStageKeys.add(previousStageKey);
		}
		const stage = this.stages[index];
		this.currentStageKey = key;
		if (stageChanged) {
			this.stageStartTime = now;
		}
		this.loader.setStage(stage.label, index + 1, this.stages.length);
		this.refreshProgress();
		this.options.footer.setStage(stage.label);
	}

	private formatStageLabel(key: string): string {
		if (key === "planning") return "Planning";
		if (key === "responding") return "Responding";
		const toolMeta = this.toolStageMeta.get(key);
		if (toolMeta) {
			return `Tool · ${toolMeta.toolName}`;
		}
		return key;
	}

	private refreshToolStageLabels(toolName: string): void {
		const entries = this.toolStagesByName.get(toolName);
		if (!entries || entries.length === 0) return;
		const total = entries.length;
		entries.forEach((key, index) => {
			const label =
				total > 1
					? `Tool · ${toolName} (${index + 1}/${total})`
					: `Tool · ${toolName}`;
			this.renameStage(key, label);
		});
	}

	private renameStage(key: string, label: string): void {
		const stage = this.stages.find((entry) => entry.key === key);
		if (!stage) return;
		stage.label = label;
		if (this.currentStageKey === key && this.loader) {
			const index = this.stages.findIndex((entry) => entry.key === key);
			this.loader.setStage(label, index + 1, this.stages.length);
			this.options.footer.setStage(label);
		}
	}

	private refreshProgress(): void {
		if (!this.loader || !this.currentStageKey) return;
		const total = this.stages.length;
		if (total === 0) {
			this.loader.setProgress(null);
			return;
		}
		const completedCount = this.stages.reduce((count, stage) => {
			return this.completedStageKeys.has(stage.key) ? count + 1 : count;
		}, 0);
		const currentStageCompleted = this.completedStageKeys.has(
			this.currentStageKey,
		);
		const currentPartial = currentStageCompleted
			? 0
			: this.getCurrentStageProgress(this.currentStageKey);
		if (this.currentStageKey === "responding") {
			this.loader.setProgress(null);
			return;
		}
		const rawProgress = (completedCount + currentPartial) / total;
		const normalized = Math.min(0.99, Math.max(0, rawProgress));
		this.loader.setProgress(normalized);
	}

	private getCurrentStageProgress(stageKey: string): number {
		if (stageKey === "responding") {
			return this.streamingActive ? 0.6 : 0.85;
		}
		if (stageKey === "planning") {
			return 0.4;
		}
		if (this.toolStageMeta.has(stageKey)) {
			return this.completedToolStages.has(stageKey) ? 0.75 : 0.5;
		}
		return 0.3;
	}

	private finalizeStageTiming(): void {
		if (this.currentStageKey && this.stageStartTime) {
			this.recordStageTiming(this.currentStageKey, Date.now() - this.stageStartTime);
		}
		this.stageStartTime = null;
	}

	private recordStageTiming(stageKey: string, durationMs: number): void {
		if (!this.options.telemetryEnabled) return;
		const stage = this.stages.find((entry) => entry.key === stageKey);
		const label = stage?.label ?? stageKey;
		recordLoaderStage(label, durationMs, {
			stageKey,
			stages: this.stages.map((entry) => entry.label),
		});
	}
}
