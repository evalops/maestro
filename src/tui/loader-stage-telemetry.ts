import { recordLoaderStage } from "../telemetry.js";

interface LoaderStageEntry {
	key: string;
	label: string;
}

export class LoaderStageTelemetry {
	private currentStage: string | null = null;
	private stageStartTime: number | null = null;
	constructor(private readonly enabled: boolean) {}

	updateCurrentStage(key: string): void {
		this.currentStage = key;
		this.stageStartTime = Date.now();
	}

	recordStage(stageKey: string, stages: LoaderStageEntry[]): void {
		if (!this.enabled || !this.stageStartTime) return;
		const duration = Date.now() - this.stageStartTime;
		this.logStage(stageKey, stages, duration);
		this.stageStartTime = Date.now();
	}

	finalize(stages: LoaderStageEntry[]): void {
		if (this.currentStage && this.stageStartTime) {
			this.logStage(
				this.currentStage,
				stages,
				Date.now() - this.stageStartTime,
			);
		}
		this.currentStage = null;
		this.stageStartTime = null;
	}

	private logStage(
		stageKey: string,
		stages: LoaderStageEntry[],
		durationMs: number,
	): void {
		const stage = stages.find((entry) => entry.key === stageKey);
		const label = stage?.label ?? stageKey;
		recordLoaderStage(label, durationMs, {
			stageKey,
			stages: stages.map((entry) => entry.label),
		});
	}
}
