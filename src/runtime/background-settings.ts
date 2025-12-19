import {
	type FSWatcher,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	watch,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { getAgentDir } from "../config/constants.js";
import { createLogger } from "../utils/logger.js";
import { expandUserPath, safejoin } from "../utils/path-validation.js";

const logger = createLogger("runtime:background-settings");

export interface BackgroundTaskSettings {
	notificationsEnabled: boolean;
	statusDetailsEnabled: boolean;
}

const DEFAULT_SETTINGS: BackgroundTaskSettings = {
	notificationsEnabled: false,
	statusDetailsEnabled: false,
};

const SETTINGS_ROOT = resolve(getAgentDir());
const SETTINGS_FILENAME = "background-settings.json";
const DEFAULT_SETTINGS_PATH = join(SETTINGS_ROOT, SETTINGS_FILENAME);
const RELOAD_THROTTLE_MS = 500;

type SettingsListener = (settings: BackgroundTaskSettings) => void;

let settingsCache: BackgroundTaskSettings | null = null;
let settingsPathOverride: string | null = null;
const listeners = new Set<SettingsListener>();
let settingsMtimeMs: number | null = null;
let settingsSize: number | null = null;
let lastReloadCheckMs = 0;
let watcher: FSWatcher | null = null;
const MAX_READ_RETRIES = 2;

function resolveOverridePath(target: string): string {
	const expanded = expandUserPath(target);
	return resolve(expanded);
}

function resolveEnvPath(raw: string): string | null {
	const trimmed = raw.trim();
	if (!trimmed) {
		return null;
	}
	const expanded = expandUserPath(trimmed);
	try {
		const resolved = resolve(expanded);
		if (
			resolved === SETTINGS_ROOT ||
			resolved.startsWith(`${SETTINGS_ROOT}/`)
		) {
			return resolved;
		}
		return safejoin(SETTINGS_ROOT, expanded);
	} catch (error) {
		logger.warn("Ignoring unsafe COMPOSER_BACKGROUND_SETTINGS path", {
			path: trimmed,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

function getSettingsPath(): string {
	if (settingsPathOverride) {
		return resolveOverridePath(settingsPathOverride);
	}
	const custom = process.env.COMPOSER_BACKGROUND_SETTINGS;
	if (custom) {
		const resolved = resolveEnvPath(custom);
		if (resolved) {
			return resolved;
		}
	}
	return DEFAULT_SETTINGS_PATH;
}

export function getBackgroundSettingsPath(): string {
	return getSettingsPath();
}

function persistSettings(settings: BackgroundTaskSettings): void {
	const path = getSettingsPath();
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, JSON.stringify(settings, null, 2), {
		encoding: "utf-8",
		mode: 0o600,
	});
	try {
		const stat = statSync(path);
		settingsMtimeMs = stat.mtimeMs;
		settingsSize = stat.size;
	} catch {
		settingsMtimeMs = null;
		settingsSize = null;
	}
}

function normalizeSettings(
	input: Partial<BackgroundTaskSettings> | null | undefined,
): BackgroundTaskSettings {
	if (!input) {
		return { ...DEFAULT_SETTINGS };
	}
	return {
		notificationsEnabled: Boolean(input.notificationsEnabled),
		statusDetailsEnabled: Boolean(input.statusDetailsEnabled),
	};
}

function loadSettings(retry = 0): {
	settings: BackgroundTaskSettings;
	mtime: number | null;
	size: number | null;
} {
	const path = getSettingsPath();
	if (!existsSync(path)) {
		return { settings: { ...DEFAULT_SETTINGS }, mtime: null, size: null };
	}
	try {
		const before = statSync(path);
		const rawText = readFileSync(path, "utf-8");
		const after = statSync(path);
		if (
			(after.mtimeMs !== before.mtimeMs || after.size !== before.size) &&
			retry < MAX_READ_RETRIES
		) {
			return loadSettings(retry + 1);
		}
		const raw = JSON.parse(rawText) as Partial<BackgroundTaskSettings>;
		return {
			settings: normalizeSettings({ ...DEFAULT_SETTINGS, ...raw }),
			mtime: after.mtimeMs,
			size: after.size,
		};
	} catch (error) {
		logger.warn("Failed to load background settings; using defaults", {
			error: error instanceof Error ? error.message : String(error),
		});
		return { settings: { ...DEFAULT_SETTINGS }, mtime: null, size: null };
	}
}

function emit(settings: BackgroundTaskSettings): void {
	for (const listener of listeners) {
		try {
			listener({ ...settings });
		} catch (error) {
			logger.error(
				"Background task settings listener error",
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}
}

function ensureWatcher(): void {
	const path = getSettingsPath();
	if (!existsSync(path)) {
		return;
	}
	if (watcher) {
		return;
	}
	try {
		watcher = watch(path, { persistent: false }, () => {
			settingsMtimeMs = null;
			settingsSize = null;
		});
		watcher.on("error", (error) => {
			logger.warn("Background settings watcher error", {
				error: error instanceof Error ? error.message : String(error),
			});
			watcher = null;
		});
	} catch (error) {
		logger.warn("Unable to watch background settings; falling back to stat", {
			error: error instanceof Error ? error.message : String(error),
		});
		watcher = null;
	}
}

function maybeReloadSettingsFromDisk(): void {
	const now = Date.now();
	if (now - lastReloadCheckMs < RELOAD_THROTTLE_MS) {
		return;
	}
	lastReloadCheckMs = now;
	const path = getSettingsPath();
	if (!existsSync(path)) {
		if (settingsCache) {
			settingsCache = { ...DEFAULT_SETTINGS };
			settingsMtimeMs = null;
			settingsSize = null;
			emit(settingsCache);
		}
		return;
	}
	try {
		const stat = statSync(path);
		const currentMtime = stat.mtimeMs;
		const currentSize = stat.size;
		if (
			settingsMtimeMs !== null &&
			currentMtime < settingsMtimeMs &&
			currentSize === settingsSize
		) {
			return;
		}
		const loaded = loadSettings();
		settingsCache = loaded.settings;
		settingsMtimeMs = loaded.mtime ?? currentMtime;
		settingsSize = loaded.size ?? currentSize;
		emit(settingsCache);
	} catch (error) {
		logger.warn("Failed to reload background settings; keeping cache", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export function getBackgroundTaskSettings(): BackgroundTaskSettings {
	if (!settingsCache) {
		const loaded = loadSettings();
		settingsCache = loaded.settings;
		settingsMtimeMs = loaded.mtime;
		settingsSize = loaded.size;
	}
	ensureWatcher();
	maybeReloadSettingsFromDisk();
	return { ...settingsCache };
}

export function updateBackgroundTaskSettings(
	patch: Partial<BackgroundTaskSettings>,
): BackgroundTaskSettings {
	const current = getBackgroundTaskSettings();
	const next = normalizeSettings({ ...current, ...patch });
	persistSettings(next);
	settingsCache = next;
	emit(next);
	return { ...next };
}

export function resetBackgroundTaskSettings(): BackgroundTaskSettings {
	const next = { ...DEFAULT_SETTINGS };
	persistSettings(next);
	settingsCache = next;
	emit(next);
	return { ...next };
}

export function subscribeBackgroundTaskSettings(
	listener: SettingsListener,
): () => void {
	addListener(listener);
	return () => {
		listeners.delete(listener);
	};
}

function addListener(listener: SettingsListener): void {
	listeners.add(listener);
	listener(getBackgroundTaskSettings());
}

export function overrideBackgroundTaskSettingsPath(path: string | null): void {
	if (path === null) {
		settingsPathOverride = null;
		settingsCache = null;
		if (watcher) {
			watcher.close();
			watcher = null;
		}
		const next = getBackgroundTaskSettings();
		emit(next);
		return;
	}

	const allowUnsafeOverride =
		process.env.COMPOSER_BACKGROUND_SETTINGS_UNSAFE === "1" ||
		process.env.VITEST === "true" ||
		process.env.NODE_ENV === "test";

	try {
		const resolved = resolveOverridePath(path);
		const withinRoot =
			resolved === SETTINGS_ROOT || resolved.startsWith(`${SETTINGS_ROOT}/`);
		if (!withinRoot && !allowUnsafeOverride) {
			logger.warn(
				"Ignoring unsafe background settings override outside composer directory",
				{ path },
			);
			return;
		}
		if (!withinRoot && allowUnsafeOverride) {
			settingsPathOverride = resolved;
		} else {
			try {
				safejoin(SETTINGS_ROOT, resolved);
				settingsPathOverride = resolved;
			} catch (error) {
				logger.warn(
					"Ignoring unsafe background settings override outside composer directory",
					{
						path,
						error: error instanceof Error ? error.message : String(error),
					},
				);
				return;
			}
		}
	} catch {
		logger.warn("Ignoring invalid background settings override path", {
			path,
		});
		return;
	}

	settingsCache = null;
	if (watcher) {
		watcher.close();
		watcher = null;
	}
	const next = getBackgroundTaskSettings();
	emit(next);
}

export function getDefaultBackgroundTaskSettings(): BackgroundTaskSettings {
	return { ...DEFAULT_SETTINGS };
}

/**
 * Cleanup function to close the watcher and clear listeners.
 * Useful for testing or when the module needs to be reset.
 */
export function cleanupBackgroundTaskSettings(): void {
	if (watcher) {
		watcher.close();
		watcher = null;
	}
	listeners.clear();
	settingsCache = null;
	settingsMtimeMs = null;
	settingsSize = null;
	lastReloadCheckMs = 0;
}
