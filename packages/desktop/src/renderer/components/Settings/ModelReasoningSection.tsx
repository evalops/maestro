import { useMemo } from "react";
import type { ModeStatus, ModeSummary } from "../../lib/api-client";
import { dedupeModels, getModelKey } from "../../lib/model-utils";
import type { Model, ThinkingLevel } from "../../lib/types";

export const DEFAULT_MODE_OPTIONS = ["smart", "rush", "free", "custom"];

export interface ModelOptionViewModel {
	id: string;
	label: string;
}

export interface ModelReasoningViewModel {
	modelOptions: ModelOptionViewModel[];
	modelEmptyLabel: string | null;
	selectedModelId: string;
	modeOptions: string[];
	selectedMode: string;
	modeDescription: string | null;
	thinkingLevel: ThinkingLevel;
}

export interface ModelReasoningSectionProps {
	availableModels: Model[];
	fallbackModels: Model[];
	selectedModelId: string;
	modeStatus: ModeStatus | null;
	modeOptions: string[];
	thinkingLevel: ThinkingLevel;
	onUpdateModel: (modelId: string) => Promise<void> | void;
	onUpdateMode: (mode: string) => Promise<void> | void;
	onThinkingLevelChange: (level: ThinkingLevel) => void;
}

export function normalizeModeOptions(
	modes: Array<string | ModeSummary>,
): string[] {
	const normalized = modes
		.map((entry) => (typeof entry === "string" ? entry : entry.mode))
		.filter((entry): entry is string => Boolean(entry));

	return normalized.length
		? Array.from(new Set(normalized))
		: DEFAULT_MODE_OPTIONS;
}

export function buildModelReasoningViewModel(
	availableModels: Model[],
	fallbackModels: Model[],
	selectedModelId: string,
	modeStatus: ModeStatus | null,
	modeOptions: string[],
	thinkingLevel: ThinkingLevel,
): ModelReasoningViewModel {
	const models = dedupeModels(
		availableModels.length > 0 ? availableModels : fallbackModels,
	);
	const resolvedModeOptions = modeOptions.length
		? modeOptions
		: DEFAULT_MODE_OPTIONS;

	return {
		modelOptions: models.map((model) => ({
			id: getModelKey(model),
			label: `${model.name || model.id} · ${model.provider}`,
		})),
		modelEmptyLabel: models.length > 0 ? null : "No models detected",
		selectedModelId,
		modeOptions: resolvedModeOptions,
		selectedMode: modeStatus?.mode ?? resolvedModeOptions[0],
		modeDescription: modeStatus?.config?.description ?? null,
		thinkingLevel,
	};
}

export function ModelReasoningSection({
	availableModels,
	fallbackModels,
	selectedModelId,
	modeStatus,
	modeOptions,
	thinkingLevel,
	onUpdateModel,
	onUpdateMode,
	onThinkingLevelChange,
}: ModelReasoningSectionProps) {
	const modelReasoning = useMemo(
		() =>
			buildModelReasoningViewModel(
				availableModels,
				fallbackModels,
				selectedModelId,
				modeStatus,
				modeOptions,
				thinkingLevel,
			),
		[
			availableModels,
			fallbackModels,
			selectedModelId,
			modeStatus,
			modeOptions,
			thinkingLevel,
		],
	);

	return (
		<section className="border border-line-subtle rounded-xl overflow-hidden">
			<div className="px-4 py-2 text-xs font-semibold text-text-tertiary border-b border-line-subtle uppercase tracking-wide">
				Model & Reasoning
			</div>
			<div className="p-4 space-y-4">
				<div className="flex items-center justify-between gap-4">
					<div>
						<div className="text-text-primary font-medium">Model</div>
						<div className="text-xs text-text-muted">Slash command: /model</div>
					</div>
					<select
						value={modelReasoning.selectedModelId}
						onChange={(event) => onUpdateModel(event.target.value)}
						className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary"
					>
						{modelReasoning.modelOptions.length === 0 && (
							<option value="">{modelReasoning.modelEmptyLabel}</option>
						)}
						{modelReasoning.modelOptions.map((model) => (
							<option key={model.id} value={model.id}>
								{model.label}
							</option>
						))}
					</select>
				</div>

				<div className="flex items-center justify-between gap-4">
					<div>
						<div className="text-text-primary font-medium">Agent mode</div>
						<div className="text-xs text-text-muted">Slash command: /mode</div>
					</div>
					<select
						value={modelReasoning.selectedMode}
						onChange={(event) => onUpdateMode(event.target.value)}
						className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary"
					>
						{modelReasoning.modeOptions.map((mode) => (
							<option key={mode} value={mode}>
								{mode}
							</option>
						))}
					</select>
				</div>
				{modelReasoning.modeDescription && (
					<div className="text-xs text-text-muted">
						{modelReasoning.modeDescription}
					</div>
				)}

				<div className="flex items-center justify-between gap-4">
					<div>
						<div className="text-text-primary font-medium">Thinking level</div>
						<div className="text-xs text-text-muted">
							Controls reasoning depth for supported models.
						</div>
					</div>
					<select
						value={modelReasoning.thinkingLevel}
						onChange={(event) =>
							onThinkingLevelChange(event.target.value as ThinkingLevel)
						}
						className="bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary"
					>
						<option value="off">Off</option>
						<option value="minimal">Minimal</option>
						<option value="low">Low</option>
						<option value="medium">Medium</option>
						<option value="high">High</option>
						<option value="max">Max</option>
					</select>
				</div>
			</div>
		</section>
	);
}
