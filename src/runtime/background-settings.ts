import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { expandUserPath, safejoin } from "../utils/path-validation.js";

export interface BackgroundTaskSettings {
	notificationsEnabled: boolean;
	statusDetailsEnabled: boolean;
}

const DEFAULT_SETTINGS: BackgroundTaskSettings = {
	notificationsEnabled: false,
	statusDetailsEnabled: false,
};

const SETTINGS_ROOT = join(homedir(), ".composer", "agent");
const SETTINGS_FILENAME = "background-settings.json";
const DEFAULT_SETTINGS_PATH = join(SETTINGS_ROOT, SETTINGS_FILENAME);

type SettingsListener = (settings: BackgroundTaskSettings) => void;

let settingsCache: BackgroundTaskSettings | null = null;
let settingsPathOverride: string | null = null;
const listeners = new Set<SettingsListener>();

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
		return safejoin(SETTINGS_ROOT, expanded);
	} catch (error) {
		console.warn("Ignoring unsafe COMPOSER_BACKGROUND_SETTINGS path", {
			path: trimmed,
			error,
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

function persistSettings(settings: BackgroundTaskSettings): void {
	const path = getSettingsPath();
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, JSON.stringify(settings, null, 2), {
		encoding: "utf-8",
		mode: 0o600,
	});
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

function loadSettings(): BackgroundTaskSettings {
	const path = getSettingsPath();
	if (!existsSync(path)) {
		return { ...DEFAULT_SETTINGS };
	}
	try {
		const raw = JSON.parse(
			readFileSync(path, "utf-8"),
		) as Partial<BackgroundTaskSettings>;
		return normalizeSettings({ ...DEFAULT_SETTINGS, ...raw });
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

function emit(settings: BackgroundTaskSettings): void {
	for (const listener of listeners) {
		try {
			listener({ ...settings });
		} catch (error) {
			console.error("Background task settings listener error", error);
		}
	}
}

export function getBackgroundTaskSettings(): BackgroundTaskSettings {
	if (!settingsCache) {
		settingsCache = loadSettings();
	}
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
	settingsPathOverride = path;
	settingsCache = null;
	const next = getBackgroundTaskSettings();
	emit(next);
}

export function getDefaultBackgroundTaskSettings(): BackgroundTaskSettings {
	return { ...DEFAULT_SETTINGS };
}
