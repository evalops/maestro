import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CleanMode } from "../../conversation/render-model.js";
import type { QueueMode } from "../../tui/ui-state.js";
import type { FooterMode } from "../../tui/utils/footer-utils.js";

/**
 * Per-session UI state that can override global UI settings.
 * Each session can have its own preferences for zen mode, clean mode, etc.
 */
export interface SessionUiState {
	zenMode?: boolean;
	cleanMode?: CleanMode;
	footerMode?: FooterMode;
	compactTools?: boolean;
	queueMode?: QueueMode;
}

/**
 * Root structure for the web UI state file.
 * Maps session IDs to their individual UI states.
 */
interface WebUiStateFile {
	sessions: Record<string, SessionUiState>;
}

const WEB_UI_STATE_PATH =
	process.env.COMPOSER_WEB_UI_STATE ??
	join(homedir(), ".composer", "agent", "web-ui-state.json");

const MAX_SESSIONS = 200;
const KEY_REGEX = /^[A-Za-z0-9._-]+$/;

function sanitizeKey(key: string): string | null {
	if (!KEY_REGEX.test(key)) return null;
	return key;
}

function normalizeSessionState(raw: unknown): SessionUiState {
	if (!raw || typeof raw !== "object") return {};
	const state = raw as Record<string, unknown>;
	const result: SessionUiState = {};

	if (typeof state.zenMode === "boolean") {
		result.zenMode = state.zenMode;
	}
	if (
		state.cleanMode === "off" ||
		state.cleanMode === "soft" ||
		state.cleanMode === "aggressive"
	) {
		result.cleanMode = state.cleanMode as CleanMode;
	}
	if (state.footerMode === "ensemble" || state.footerMode === "solo") {
		result.footerMode = state.footerMode as FooterMode;
	}
	if (typeof state.compactTools === "boolean") {
		result.compactTools = state.compactTools;
	}
	if (state.queueMode === "one" || state.queueMode === "all") {
		result.queueMode = state.queueMode as QueueMode;
	}

	return result;
}

function normalizeState(raw: unknown): WebUiStateFile {
	if (!raw || typeof raw !== "object" || !("sessions" in raw)) {
		return { sessions: {} };
	}
	const sessions = (raw as { sessions?: unknown }).sessions;
	if (!sessions || typeof sessions !== "object") return { sessions: {} };

	const result: Record<string, SessionUiState> = {};
	for (const [k, v] of Object.entries(sessions as Record<string, unknown>)) {
		const key = sanitizeKey(k);
		if (!key) continue;
		result[key] = normalizeSessionState(v);
	}

	// Prune old sessions if we have too many
	const entries = Object.entries(result);
	if (entries.length > MAX_SESSIONS) {
		entries.splice(0, entries.length - MAX_SESSIONS);
		return { sessions: Object.fromEntries(entries) };
	}

	return { sessions: result };
}

/**
 * Load the web UI state file from disk.
 * Returns an object with per-session UI states.
 */
export function loadWebUiState(): WebUiStateFile {
	if (!existsSync(WEB_UI_STATE_PATH)) return { sessions: {} };
	try {
		const raw = JSON.parse(readFileSync(WEB_UI_STATE_PATH, "utf-8")) as unknown;
		return normalizeState(raw);
	} catch {
		return { sessions: {} };
	}
}

/**
 * Save the web UI state file to disk.
 */
export function saveWebUiState(state: WebUiStateFile): void {
	const normalized = normalizeState(state);
	mkdirSync(dirname(WEB_UI_STATE_PATH), { recursive: true });
	writeFileSync(
		WEB_UI_STATE_PATH,
		JSON.stringify(normalized, null, 2),
		"utf-8",
	);
}

/**
 * Get or create the UI state for a specific session.
 * If the session doesn't exist, creates an empty state entry.
 */
export function getSessionUiState(
	state: WebUiStateFile,
	sessionId: string,
): SessionUiState {
	const key = sanitizeKey(sessionId);
	if (!key) {
		throw new Error("Invalid sessionId format");
	}
	if (!state.sessions[key]) {
		state.sessions[key] = {};
	}
	return state.sessions[key];
}
