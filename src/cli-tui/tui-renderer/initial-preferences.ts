import type { CleanMode } from "../../conversation/render-model.js";
import { readCleanModeFromEnv } from "../clean-mode.js";
import type { QueueMode, UiState } from "../ui-state.js";
import { loadCommandPrefs, loadUiState } from "../ui-state.js";
import type { FooterMode } from "../utils/footer-utils.js";
import {
	isReducedMotionEnabled,
	setReducedMotionEnv,
} from "../utils/motion.js";

export type InitialQueueMode = QueueMode;

export interface TuiRendererInitialPreferences {
	uiState: UiState;
	initialSteeringMode: InitialQueueMode;
	initialFollowUpMode: InitialQueueMode;
	cleanMode?: CleanMode;
	footerMode?: FooterMode;
	reducedMotion?: boolean;
	reducedMotionForced: boolean;
	zenMode?: boolean;
	hideThinkingBlocks?: boolean;
	recentCommands: string[];
	favoriteCommands: Set<string>;
}

export function loadInitialTuiRendererPreferences(): TuiRendererInitialPreferences {
	const uiState = loadUiState();

	const initialSteeringMode: QueueMode =
		uiState.steeringMode === "one" || uiState.steeringMode === "all"
			? uiState.steeringMode
			: uiState.queueMode === "one" || uiState.queueMode === "all"
				? uiState.queueMode
				: "all";

	const initialFollowUpMode: QueueMode =
		uiState.followUpMode === "one" || uiState.followUpMode === "all"
			? uiState.followUpMode
			: uiState.queueMode === "one" || uiState.queueMode === "all"
				? uiState.queueMode
				: "all";

	const envCleanMode = readCleanModeFromEnv();
	const cleanMode = envCleanMode ?? uiState.cleanMode;

	const envReducedMotion = isReducedMotionEnabled();
	const reducedMotion =
		typeof uiState.reducedMotion === "boolean"
			? uiState.reducedMotion
			: envReducedMotion;
	const reducedMotionForced = !!(
		envReducedMotion && uiState.reducedMotion !== false
	);
	setReducedMotionEnv(reducedMotion);

	const recentCommands: string[] = Array.isArray(uiState.recentCommands)
		? [...uiState.recentCommands]
		: [];
	const favoriteCommands = new Set<string>();
	if (Array.isArray(uiState.favoriteCommands)) {
		for (const name of uiState.favoriteCommands) {
			favoriteCommands.add(name);
		}
	}

	const diskPrefs = loadCommandPrefs();
	if (diskPrefs.recents.length > 0) {
		recentCommands.splice(0, recentCommands.length, ...diskPrefs.recents);
	}
	for (const fav of diskPrefs.favorites) {
		favoriteCommands.add(fav);
	}

	return {
		uiState,
		initialSteeringMode,
		initialFollowUpMode,
		cleanMode: cleanMode ?? undefined,
		footerMode: uiState.footerMode,
		reducedMotion,
		reducedMotionForced,
		zenMode: uiState.zenMode,
		hideThinkingBlocks: uiState.hideThinkingBlocks,
		recentCommands,
		favoriteCommands,
	};
}
