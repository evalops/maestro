import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PATHS } from "../config/constants.js";
import type { CleanMode } from "../conversation/render-model.js";
import { resolveEnvPath } from "../utils/path-expansion.js";
import type { FooterMode } from "./utils/footer-utils.js";

export type QueueMode = "one" | "all";

export interface UiState {
	queueMode?: QueueMode;
	compactTools?: boolean;
	footerMode?: FooterMode;
	zenMode?: boolean;
	cleanMode?: CleanMode;
	reducedMotion?: boolean;
	hideThinkingBlocks?: boolean;
	recentCommands?: string[];
	favoriteCommands?: string[];
}

const getUiStatePath = () =>
	resolveEnvPath(process.env.COMPOSER_UI_STATE) ?? PATHS.UI_STATE_FILE;

const getCommandPrefsPath = () =>
	resolveEnvPath(process.env.COMPOSER_COMMAND_PREFS) ??
	PATHS.COMMAND_PREFS_FILE;

export function loadUiState(): UiState {
	const uiStatePath = getUiStatePath();
	if (!existsSync(uiStatePath)) {
		return {};
	}
	try {
		const raw = readFileSync(uiStatePath, "utf-8");
		const parsed = JSON.parse(raw) as UiState;
		return {
			queueMode:
				parsed.queueMode === "one" || parsed.queueMode === "all"
					? parsed.queueMode
					: undefined,
			compactTools:
				typeof parsed.compactTools === "boolean"
					? parsed.compactTools
					: undefined,
			footerMode:
				parsed.footerMode === "ensemble" || parsed.footerMode === "solo"
					? parsed.footerMode
					: undefined,
			cleanMode:
				parsed.cleanMode === "soft" ||
				parsed.cleanMode === "aggressive" ||
				parsed.cleanMode === "off"
					? parsed.cleanMode
					: undefined,
			zenMode: typeof parsed.zenMode === "boolean" ? parsed.zenMode : undefined,
			reducedMotion:
				typeof parsed.reducedMotion === "boolean"
					? parsed.reducedMotion
					: undefined,
			hideThinkingBlocks:
				typeof parsed.hideThinkingBlocks === "boolean"
					? parsed.hideThinkingBlocks
					: undefined,
			recentCommands: Array.isArray(parsed.recentCommands)
				? (parsed.recentCommands as string[]).filter(
						(item) => typeof item === "string" && item.trim().length > 0,
					)
				: undefined,
			favoriteCommands: Array.isArray(parsed.favoriteCommands)
				? (parsed.favoriteCommands as string[]).filter(
						(item) => typeof item === "string" && item.trim().length > 0,
					)
				: undefined,
		};
	} catch {
		return {};
	}
}

export function saveUiState(partial: UiState): void {
	const current = loadUiState();
	const next: UiState = { ...current, ...partial };
	const uiStatePath = getUiStatePath();
	mkdirSync(dirname(uiStatePath), { recursive: true });
	writeFileSync(uiStatePath, JSON.stringify(next, null, 2), "utf-8");
}

export function loadCommandPrefs(): {
	favorites: string[];
	recents: string[];
} {
	const prefsPath = getCommandPrefsPath();
	if (!existsSync(prefsPath)) {
		return { favorites: [], recents: [] };
	}
	try {
		const raw = readFileSync(prefsPath, "utf-8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const favorites = Array.isArray(parsed.favorites)
			? (parsed.favorites as unknown[]).filter(
					(item): item is string => typeof item === "string",
				)
			: [];
		const recents = Array.isArray(parsed.recents)
			? (parsed.recents as unknown[]).filter(
					(item): item is string => typeof item === "string",
				)
			: [];
		return { favorites, recents };
	} catch {
		return { favorites: [], recents: [] };
	}
}

export function saveCommandPrefs(prefs: {
	favorites: string[];
	recents: string[];
}): void {
	const prefsPath = getCommandPrefsPath();
	mkdirSync(dirname(prefsPath), { recursive: true });
	writeFileSync(prefsPath, JSON.stringify(prefs, null, 2), "utf-8");
}
