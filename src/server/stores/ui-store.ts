import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { UiState } from "../../cli-tui/ui-state.js";
import { tryParseJson } from "../../utils/json.js";

const UI_STATE_PATH =
	process.env.COMPOSER_WEB_UI_STATE ??
	join(homedir(), ".composer", "agent", "web-ui-state.json");

const KEY_REGEX = /^[A-Za-z0-9._-]+$/;

interface UiStateFile {
	sessions: Record<string, UiState>;
}

function sanitizeKey(key: string): string | null {
	return KEY_REGEX.test(key) ? key : null;
}

function normalize(raw: unknown): UiStateFile {
	if (!raw || typeof raw !== "object" || !("sessions" in raw)) {
		return { sessions: {} };
	}
	const sessions = (raw as { sessions?: unknown }).sessions;
	if (!sessions || typeof sessions !== "object") return { sessions: {} };
	const result: Record<string, UiState> = {};
	for (const [k, v] of Object.entries(sessions as Record<string, unknown>)) {
		const key = sanitizeKey(k);
		if (!key) continue;
		if (v && typeof v === "object") {
			const state = v as UiState;
			result[key] = {
				queueMode: state.queueMode,
				compactTools: state.compactTools,
				footerMode: state.footerMode,
				cleanMode: state.cleanMode,
				reducedMotion: state.reducedMotion,
				recentCommands: state.recentCommands,
				favoriteCommands: state.favoriteCommands,
				zenMode: state.zenMode,
			};
		}
	}
	return { sessions: result };
}

export function loadWebUiState(): UiStateFile {
	if (!existsSync(UI_STATE_PATH)) return { sessions: {} };
	const raw = tryParseJson(readFileSync(UI_STATE_PATH, "utf-8"));
	return normalize(raw);
}

export function saveWebUiState(state: UiStateFile): void {
	const normalized = normalize(state);
	mkdirSync(dirname(UI_STATE_PATH), { recursive: true });
	writeFileSync(UI_STATE_PATH, JSON.stringify(normalized, null, 2), "utf-8");
}

export function getSessionUiState(
	state: UiStateFile,
	sessionId: string,
): UiState {
	const key = sanitizeKey(sessionId);
	if (!key) throw new Error("Invalid sessionId format");
	if (!state.sessions[key]) state.sessions[key] = {};
	return state.sessions[key];
}
