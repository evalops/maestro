import { themePalette } from "../../style/theme.js";
import type { ShimmerOptions } from "./shimmer.js";

export type StageKind = "thinking" | "working" | "responding" | "dreaming";

export const STAGE_DISPLAY_LABELS: Record<StageKind, string> = {
	dreaming: "Dreaming",
	responding: "Responding",
	thinking: "Thinking",
	working: "Working",
};

export const STAGE_SHIMMER_OPTIONS: Record<StageKind, ShimmerOptions> = {
	dreaming: {
		padding: 2.2,
		bandWidth: 2.8,
		sweepSeconds: 3,
		intensityScale: 0.6,
		baseColor: "#f0bbff",
		highlightColor: "#ffffff",
		bold: false,
	},
	responding: {
		padding: 2,
		bandWidth: 2,
		sweepSeconds: 2.1,
		intensityScale: 0.7,
		baseColor: themePalette.rubyPrimary,
		highlightColor: themePalette.rubyHighlight,
		bold: false,
	},
	thinking: {
		padding: 2,
		bandWidth: 2.5,
		sweepSeconds: 2.4,
		intensityScale: 0.55,
		baseColor: "#cbd5f5",
		highlightColor: "#ffffff",
		bold: false,
	},
	working: {
		padding: 2,
		bandWidth: 1.8,
		sweepSeconds: 1.6,
		intensityScale: 0.75,
		baseColor: "#fde68a",
		highlightColor: "#fff7ed",
		bold: false,
	},
};

export function normalizeStageLabel(label: string): string {
	return label.trim();
}

export function detectStageKind(label: string): StageKind | undefined {
	const normalized = label.trim().toLowerCase();
	if (!normalized) return undefined;
	return (Object.entries(STAGE_DISPLAY_LABELS) as [StageKind, string][]).find(
		([, display]) => normalized.startsWith(display.toLowerCase()),
	)?.[0];
}

export function formatStageLabel(kind: StageKind): string {
	return STAGE_DISPLAY_LABELS[kind];
}

export function formatWorkingStageLabel(
	toolName: string,
	index?: number,
	total?: number,
): string {
	const base = `${STAGE_DISPLAY_LABELS.working} · ${toolName}`;
	if (total && total > 1 && index !== undefined) {
		return `${base} (${index}/${total})`;
	}
	return base;
}
