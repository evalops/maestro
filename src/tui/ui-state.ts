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
}

const UI_STATE_PATH =
	process.env.COMPOSER_UI_STATE ??
	join(homedir(), ".composer", "agent", "ui-state.json");

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
