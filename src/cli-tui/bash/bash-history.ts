import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PATHS } from "../../config/constants.js";

const MAX_HISTORY_SIZE = 500;

export interface BashHistoryStore {
	entries: string[];
	version: number;
}

/**
 * Get the history file path. Evaluated at call time to support testing.
 */
export function getHistoryFilePath(): string {
	return process.env.COMPOSER_BASH_HISTORY ?? PATHS.BASH_HISTORY_FILE;
}

/**
 * Load bash command history from disk.
 */
export function loadBashHistory(): string[] {
	const historyFile = getHistoryFilePath();
	try {
		if (!existsSync(historyFile)) {
			return [];
		}
		const raw = readFileSync(historyFile, "utf-8");
		const data: BashHistoryStore = JSON.parse(raw);
		if (!Array.isArray(data.entries)) {
			return [];
		}
		return data.entries.slice(-MAX_HISTORY_SIZE);
	} catch {
		return [];
	}
}

/**
 * Save bash command history to disk.
 */
export function saveBashHistory(entries: string[]): void {
	const historyFile = getHistoryFilePath();
	try {
		const dir = dirname(historyFile);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		const data: BashHistoryStore = {
			entries: entries.slice(-MAX_HISTORY_SIZE),
			version: 1,
		};
		writeFileSync(historyFile, JSON.stringify(data, null, 2), "utf-8");
	} catch {
		// Silently fail - history persistence is best-effort
	}
}

/**
 * Append a single command to history and persist.
 */
export function appendToHistory(history: string[], command: string): string[] {
	const trimmed = command.trim();
	if (!trimmed) {
		return history;
	}
	// Avoid consecutive duplicates
	if (history[history.length - 1] === trimmed) {
		return history;
	}
	const updated = [...history, trimmed];
	if (updated.length > MAX_HISTORY_SIZE) {
		updated.shift();
	}
	saveBashHistory(updated);
	return updated;
}
