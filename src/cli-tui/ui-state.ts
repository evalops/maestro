import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CleanMode } from "../conversation/render-model.js";
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

const UI_STATE_PATH =
	process.env.COMPOSER_UI_STATE ??
	join(homedir(), ".composer", "agent", "ui-state.json");

const getCommandPrefsPath = () =>
	process.env.COMPOSER_COMMAND_PREFS ??
	join(homedir(), ".composer", "agent", "command-prefs.json");

export function loadUiState(): UiState {
	if (!existsSync(UI_STATE_PATH)) {
		return {};
	}
	try {
		const raw = readFileSync(UI_STATE_PATH, "utf-8");
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
	mkdirSync(dirname(UI_STATE_PATH), { recursive: true });
	writeFileSync(UI_STATE_PATH, JSON.stringify(next, null, 2), "utf-8");
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
