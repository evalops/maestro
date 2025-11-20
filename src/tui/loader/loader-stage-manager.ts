import { LoaderStageTelemetry } from "./loader-stage-telemetry.js";

interface LoaderStageEntry {
	key: string;
	label: string;
}

interface LoaderStageManagerOptions {
	setFooterStage: (label: string | null) => void;
	onStageChanged: (label: string, index: number, total: number) => void;
	onProgressChanged: (value: number | null) => void;
}

export class LoaderStageManager {
	private stages: LoaderStageEntry[] = [];
	private toolStageMeta = new Map<string, { toolName: string }>();
	private toolStagesByName = new Map<string, string[]>();
	private completedToolStages = new Set<string>();
	private completedStageKeys = new Set<string>();
	private currentStageKey: string | null = null;
	private streamingActive = false;
	private telemetry: LoaderStageTelemetry;

	constructor(private readonly options: LoaderStageManagerOptions) {
		this.telemetry = new LoaderStageTelemetry();
	}

	start(): void {
		this.resetTracking();
		this.updateStage("planning");
	}

	stop(): void {
		this.clearTracking();
	}

	setStreamingActive(active: boolean): void {
		this.streamingActive = active;
	}

	maybeTransitionToResponding(): void {
		const noToolStages = this.toolStageMeta.size === 0;
		const allComplete =
			this.toolStageMeta.size > 0 &&
			this.completedToolStages.size === this.toolStageMeta.size;
		if (noToolStages || allComplete) {
			this.updateStage("responding");
		}
	}

	registerToolStage(toolCallId: string, toolName: string): void {
		if (this.toolStageMeta.has(toolCallId)) {
			this.updateStage(toolCallId);
			return;
		}
		this.toolStageMeta.set(toolCallId, { toolName });
		const respondingIndex = this.stages.findIndex(
			(stage) => stage.key === "responding",
		);
		const insertIndex =
			respondingIndex === -1 ? this.stages.length : respondingIndex;
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
		if (this.currentStageKey) {
			this.completedStageKeys.add(this.currentStageKey);
			this.refreshProgress();
		}
		this.options.onProgressChanged(1);
		this.clearTracking();
	}

	completeTurn(): void {
		if (this.currentStageKey) {
			this.telemetry.recordStage(this.currentStageKey, this.stages);
			this.completedStageKeys.add(this.currentStageKey);
		}
		this.options.onProgressChanged(1);
		this.options.setFooterStage(null);
		this.currentStageKey = null;
	}

	private resetTracking(): void {
		this.telemetry.finalize(this.stages);
		this.stages = [
			{ key: "planning", label: "Planning" },
			{ key: "responding", label: "Responding" },
		];
		this.toolStageMeta.clear();
		this.toolStagesByName.clear();
		this.completedToolStages.clear();
		this.completedStageKeys.clear();
		this.currentStageKey = null;
		this.options.setFooterStage(null);
	}

	private clearTracking(): void {
		this.telemetry.finalize(this.stages);
		this.stages = [];
		this.toolStageMeta.clear();
		this.toolStagesByName.clear();
		this.completedToolStages.clear();
		this.completedStageKeys.clear();
		this.currentStageKey = null;
		this.options.setFooterStage(null);
		this.options.onProgressChanged(null);
	}

	private updateStage(key: string, labelOverride?: string): void {
		const stageChanged = this.currentStageKey !== key;
		if (stageChanged && this.currentStageKey) {
			this.telemetry.recordStage(this.currentStageKey, this.stages);
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
			this.telemetry.updateCurrentStage(key);
		}
		this.options.onStageChanged(stage.label, index + 1, this.stages.length);
		this.options.setFooterStage(stage.label);
		this.refreshProgress();
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
		if (this.currentStageKey === key) {
			const index = this.stages.findIndex((entry) => entry.key === key);
			this.options.onStageChanged(label, index + 1, this.stages.length);
			this.options.setFooterStage(label);
		}
	}

	private refreshProgress(): void {
		if (!this.currentStageKey) {
			this.options.onProgressChanged(null);
			return;
		}
		const total = this.stages.length;
		if (total === 0) {
			this.options.onProgressChanged(null);
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
			this.options.onProgressChanged(null);
			return;
		}
		const rawProgress = (completedCount + currentPartial) / total;
		const normalized = Math.min(0.99, Math.max(0, rawProgress));
		this.options.onProgressChanged(normalized);
	}

	private getCurrentStageProgress(stageKey: string): number {
		if (stageKey === "responding") {
			return this.streamingActive ? 0.6 : 0.85;
		}
		if (stageKey === "planning") {
			return 0.4;
		}
		if (this.toolStageMeta.has(stageKey)) {
			// Current tool stage should use in-progress partial value
			return 0.5;
		}
		return 0.3;
	}
}
