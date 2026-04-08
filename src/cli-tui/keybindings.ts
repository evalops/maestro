import { join } from "node:path";
import { PATHS } from "../config/constants.js";
import { readJsonFile } from "../utils/fs.js";
import { resolveEnvPath } from "../utils/path-expansion.js";

export const TUI_KEYBINDING_ACTIONS = [
	"cycle-model",
	"toggle-tool-outputs",
	"toggle-thinking-blocks",
	"external-editor",
	"suspend",
	"command-palette",
	"edit-last-follow-up",
] as const;

export type TuiKeybindingAction = (typeof TUI_KEYBINDING_ACTIONS)[number];

export const TUI_KEYBINDING_SHORTCUTS = [
	"ctrl+g",
	"ctrl+k",
	"ctrl+o",
	"ctrl+p",
	"ctrl+t",
	"ctrl+z",
	"alt+up",
	"shift+left",
] as const;

export type TuiKeybindingShortcut = (typeof TUI_KEYBINDING_SHORTCUTS)[number];

interface StoredTuiKeybindingStore {
	version: 1;
	bindings: Partial<Record<TuiKeybindingAction, TuiKeybindingShortcut>>;
}

const EMPTY_TUI_KEYBINDING_STORE: StoredTuiKeybindingStore = {
	version: 1,
	bindings: {},
};

const TUI_KEYBINDING_ACTION_SET = new Set<string>(TUI_KEYBINDING_ACTIONS);
const TUI_KEYBINDING_SHORTCUT_SET = new Set<string>(TUI_KEYBINDING_SHORTCUTS);
const CTRL_SHORTCUT_LETTERS: Record<
	Extract<
		TuiKeybindingShortcut,
		"ctrl+g" | "ctrl+k" | "ctrl+o" | "ctrl+p" | "ctrl+t" | "ctrl+z"
	>,
	string
> = {
	"ctrl+g": "g",
	"ctrl+k": "k",
	"ctrl+o": "o",
	"ctrl+p": "p",
	"ctrl+t": "t",
	"ctrl+z": "z",
};

const ALT_UP_SEQUENCES = new Set(["\x1b[1;3A", "\x1b\x1b[A", "\x1b\x1bOA"]);
const SHIFT_LEFT_SEQUENCES = new Set(["\x1b[1;2D"]);
const DEFAULT_TUI_KEYBINDINGS: Record<
	Exclude<TuiKeybindingAction, "edit-last-follow-up">,
	TuiKeybindingShortcut
> = {
	"cycle-model": "ctrl+p",
	"toggle-tool-outputs": "ctrl+o",
	"toggle-thinking-blocks": "ctrl+t",
	"external-editor": "ctrl+g",
	suspend: "ctrl+z",
	"command-palette": "ctrl+k",
};

const keybindingStoreCache = new Map<
	string,
	StoredTuiKeybindingStore["bindings"]
>();

function isTuiKeybindingAction(value: string): value is TuiKeybindingAction {
	return TUI_KEYBINDING_ACTION_SET.has(value);
}

function isTuiKeybindingShortcut(
	value: string,
): value is TuiKeybindingShortcut {
	return TUI_KEYBINDING_SHORTCUT_SET.has(value);
}

function buildCtrlRawSequence(letter: string): string {
	return String.fromCharCode(letter.toLowerCase().charCodeAt(0) & 0x1f);
}

function buildCtrlKittySequence(letter: string): string {
	return `\x1b[${letter.toLowerCase().charCodeAt(0)};5u`;
}

function getShortcutLabel(shortcut: TuiKeybindingShortcut): string {
	switch (shortcut) {
		case "ctrl+g":
			return "Ctrl+G";
		case "ctrl+k":
			return "Ctrl+K";
		case "ctrl+o":
			return "Ctrl+O";
		case "ctrl+p":
			return "Ctrl+P";
		case "ctrl+t":
			return "Ctrl+T";
		case "ctrl+z":
			return "Ctrl+Z";
		case "alt+up":
			return "Alt+Up";
		case "shift+left":
			return "Shift+Left";
	}
}

function matchesShortcut(
	shortcut: TuiKeybindingShortcut,
	data: string,
): boolean {
	if (shortcut === "alt+up") {
		return ALT_UP_SEQUENCES.has(data);
	}
	if (shortcut === "shift+left") {
		return SHIFT_LEFT_SEQUENCES.has(data);
	}
	const letter = CTRL_SHORTCUT_LETTERS[shortcut];
	return (
		data === buildCtrlRawSequence(letter) ||
		data === buildCtrlKittySequence(letter)
	);
}

function getCanonicalShortcutSequence(shortcut: TuiKeybindingShortcut): string {
	if (shortcut === "alt+up") {
		return "\x1b[1;3A";
	}
	if (shortcut === "shift+left") {
		return "\x1b[1;2D";
	}
	return buildCtrlRawSequence(CTRL_SHORTCUT_LETTERS[shortcut]);
}

function getTuiKeybindingsFilePath(
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	if (env === process.env) {
		return PATHS.TUI_KEYBINDINGS_FILE;
	}
	const explicitPath = resolveEnvPath(env.MAESTRO_KEYBINDINGS_FILE);
	if (explicitPath) {
		return explicitPath;
	}
	const maestroHome = resolveEnvPath(env.MAESTRO_HOME);
	return maestroHome ? join(maestroHome, "keybindings.json") : null;
}

function normalizeTuiKeybindingStore(raw: unknown): StoredTuiKeybindingStore {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return EMPTY_TUI_KEYBINDING_STORE;
	}
	const candidate = raw as {
		version?: unknown;
		bindings?: unknown;
	};
	if (candidate.version !== 1) {
		return EMPTY_TUI_KEYBINDING_STORE;
	}

	const bindings =
		candidate.bindings && typeof candidate.bindings === "object"
			? candidate.bindings
			: {};
	const normalizedBindings: StoredTuiKeybindingStore["bindings"] = {};

	for (const [action, shortcut] of Object.entries(bindings)) {
		if (
			isTuiKeybindingAction(action) &&
			typeof shortcut === "string" &&
			isTuiKeybindingShortcut(shortcut)
		) {
			normalizedBindings[action] = shortcut;
		}
	}

	return {
		version: 1,
		bindings: normalizedBindings,
	};
}

function readTuiKeybindingOverrides(
	env: NodeJS.ProcessEnv = process.env,
): StoredTuiKeybindingStore["bindings"] {
	const filePath = getTuiKeybindingsFilePath(env);
	if (!filePath) {
		return EMPTY_TUI_KEYBINDING_STORE.bindings;
	}

	const cached = keybindingStoreCache.get(filePath);
	if (cached) {
		return cached;
	}

	const normalized = normalizeTuiKeybindingStore(
		readJsonFile<unknown>(filePath, {
			fallback: EMPTY_TUI_KEYBINDING_STORE,
		}),
	);
	keybindingStoreCache.set(filePath, normalized.bindings);
	return normalized.bindings;
}

function getDefaultQueuedFollowUpShortcut(
	env: NodeJS.ProcessEnv = process.env,
): TuiKeybindingShortcut {
	const termProgram = env.TERM_PROGRAM?.trim().toLowerCase();
	if (
		env.TMUX ||
		termProgram === "tmux" ||
		termProgram === "apple_terminal" ||
		termProgram === "warp" ||
		termProgram === "warpterminal" ||
		termProgram === "vscode"
	) {
		return "shift+left";
	}
	return "alt+up";
}

export function resetTuiKeybindingConfigCache(): void {
	keybindingStoreCache.clear();
}

export function getDefaultTuiKeybindingShortcut(
	action: TuiKeybindingAction,
	env: NodeJS.ProcessEnv = process.env,
): TuiKeybindingShortcut {
	if (action === "edit-last-follow-up") {
		return getDefaultQueuedFollowUpShortcut(env);
	}
	return DEFAULT_TUI_KEYBINDINGS[action];
}

export function getResolvedTuiKeybindings(
	env: NodeJS.ProcessEnv = process.env,
): Record<TuiKeybindingAction, TuiKeybindingShortcut> {
	const defaults = Object.fromEntries(
		TUI_KEYBINDING_ACTIONS.map((action) => [
			action,
			getDefaultTuiKeybindingShortcut(action, env),
		]),
	) as Record<TuiKeybindingAction, TuiKeybindingShortcut>;
	const overrides = readTuiKeybindingOverrides(env);
	const resolved = { ...defaults, ...overrides };

	let changed = true;
	while (changed) {
		changed = false;
		const actionsByShortcut = new Map<
			TuiKeybindingShortcut,
			TuiKeybindingAction[]
		>();
		for (const action of TUI_KEYBINDING_ACTIONS) {
			const shortcut = resolved[action];
			const actions = actionsByShortcut.get(shortcut) ?? [];
			actions.push(action);
			actionsByShortcut.set(shortcut, actions);
		}

		for (const actions of actionsByShortcut.values()) {
			if (actions.length < 2) {
				continue;
			}
			const overriddenActions = actions.filter((action) =>
				Object.prototype.hasOwnProperty.call(overrides, action),
			);
			for (const action of overriddenActions) {
				if (resolved[action] !== defaults[action]) {
					resolved[action] = defaults[action];
					changed = true;
				}
			}
		}
	}

	return resolved;
}

export function getTuiKeybindingShortcut(
	action: TuiKeybindingAction,
	env: NodeJS.ProcessEnv = process.env,
): TuiKeybindingShortcut {
	return getResolvedTuiKeybindings(env)[action];
}

export function getTuiKeybindingLabel(
	action: TuiKeybindingAction,
	env: NodeJS.ProcessEnv = process.env,
): string {
	return getShortcutLabel(getTuiKeybindingShortcut(action, env));
}

export function matchesTuiKeybinding(
	action: TuiKeybindingAction,
	data: string,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return matchesShortcut(getTuiKeybindingShortcut(action, env), data);
}

export function getTuiKeybindingSequence(
	action: TuiKeybindingAction,
	env: NodeJS.ProcessEnv = process.env,
): string {
	return getCanonicalShortcutSequence(getTuiKeybindingShortcut(action, env));
}
