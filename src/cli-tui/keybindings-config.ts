import { fileExists, readTextFile, writeTextFile } from "../utils/fs.js";
import { safeJsonParse } from "../utils/json.js";
import {
	TUI_KEYBINDING_ACTIONS,
	TUI_KEYBINDING_SHORTCUTS,
	type TuiKeybindingAction,
	type TuiKeybindingShortcut,
	getDefaultTuiKeybindingShortcut,
	getResolvedTuiKeybindings,
	getTuiKeybindingsFilePath,
} from "./keybindings.js";

const RUST_TUI_KEYBINDING_ACTIONS = [
	"command-palette",
	"file-search",
	"toggle-tool-outputs",
	"edit-last-follow-up",
] as const;

const RUST_TUI_KEYBINDING_SHORTCUTS = [
	"ctrl+p",
	"ctrl+o",
	"ctrl+t",
	"alt+up",
	"shift+left",
] as const;

type RustTuiKeybindingAction = (typeof RUST_TUI_KEYBINDING_ACTIONS)[number];
type RustTuiKeybindingShortcut = (typeof RUST_TUI_KEYBINDING_SHORTCUTS)[number];

type KeybindingIssueSeverity = "error" | "warning";

export interface KeybindingConfigIssue {
	severity: KeybindingIssueSeverity;
	message: string;
}

export interface KeybindingConfigReport {
	path: string;
	exists: boolean;
	tuiRequestedOverrides: number;
	tuiActiveOverrides: number;
	rustRequestedOverrides: number;
	rustActiveOverrides: number;
	issues: KeybindingConfigIssue[];
}

export function summarizeKeybindingConfigIssues(
	report: KeybindingConfigReport,
): string | null {
	if (!report.exists || report.issues.length === 0) {
		return null;
	}
	return `Keyboard shortcuts config has ${report.issues.length} issue${report.issues.length === 1 ? "" : "s"}. Run /hotkeys validate.`;
}

type ParsedKeybindingConfig = {
	version?: unknown;
	bindings?: unknown;
	rustBindings?: unknown;
};

const TUI_ACTION_SET = new Set<string>(TUI_KEYBINDING_ACTIONS);
const TUI_SHORTCUT_SET = new Set<string>(TUI_KEYBINDING_SHORTCUTS);
const RUST_ACTION_SET = new Set<string>(RUST_TUI_KEYBINDING_ACTIONS);
const RUST_SHORTCUT_SET = new Set<string>(RUST_TUI_KEYBINDING_SHORTCUTS);

function normalizeActionName(value: string): string {
	return value.trim().toLowerCase();
}

function normalizeShortcutName(value: string): string {
	return value.replace(/\s+/g, "").toLowerCase();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTuiAction(value: string): value is TuiKeybindingAction {
	return TUI_ACTION_SET.has(value);
}

function isTuiShortcut(value: string): value is TuiKeybindingShortcut {
	return TUI_SHORTCUT_SET.has(value);
}

function isRustAction(value: string): value is RustTuiKeybindingAction {
	return RUST_ACTION_SET.has(value);
}

function isRustShortcut(value: string): value is RustTuiKeybindingShortcut {
	return RUST_SHORTCUT_SET.has(value);
}

function getDefaultRustShortcut(
	action: RustTuiKeybindingAction,
	env: NodeJS.ProcessEnv = process.env,
): RustTuiKeybindingShortcut {
	switch (action) {
		case "command-palette":
			return "ctrl+p";
		case "file-search":
			return "ctrl+o";
		case "toggle-tool-outputs":
			return "ctrl+t";
		case "edit-last-follow-up":
			return getDefaultTuiKeybindingShortcut(
				"edit-last-follow-up",
				env,
			) as RustTuiKeybindingShortcut;
	}
}

function buildDefaultRustBindings(
	env: NodeJS.ProcessEnv = process.env,
): Record<RustTuiKeybindingAction, RustTuiKeybindingShortcut> {
	return {
		"command-palette": getDefaultRustShortcut("command-palette", env),
		"file-search": getDefaultRustShortcut("file-search", env),
		"toggle-tool-outputs": getDefaultRustShortcut("toggle-tool-outputs", env),
		"edit-last-follow-up": getDefaultRustShortcut("edit-last-follow-up", env),
	};
}

function parseTuiOverrides(
	value: unknown,
	issues: KeybindingConfigIssue[],
): Partial<Record<TuiKeybindingAction, TuiKeybindingShortcut>> {
	if (value === undefined) {
		return {};
	}
	if (!isPlainObject(value)) {
		issues.push({
			severity: "error",
			message: '"bindings" must be an object of action-to-shortcut overrides.',
		});
		return {};
	}

	const overrides: Partial<Record<TuiKeybindingAction, TuiKeybindingShortcut>> =
		{};
	for (const [rawAction, rawShortcut] of Object.entries(value)) {
		const action = normalizeActionName(rawAction);
		if (!isTuiAction(action)) {
			issues.push({
				severity: "error",
				message: `Unknown TUI keybinding action "${rawAction}". Supported actions: ${TUI_KEYBINDING_ACTIONS.join(", ")}.`,
			});
			continue;
		}
		if (typeof rawShortcut !== "string") {
			issues.push({
				severity: "error",
				message: `TUI action "${action}" must map to a shortcut string.`,
			});
			continue;
		}
		const shortcut = normalizeShortcutName(rawShortcut);
		if (!isTuiShortcut(shortcut)) {
			issues.push({
				severity: "error",
				message: `Unsupported TUI shortcut "${rawShortcut}" for "${action}". Supported shortcuts: ${TUI_KEYBINDING_SHORTCUTS.join(", ")}.`,
			});
			continue;
		}
		overrides[action] = shortcut;
	}
	return overrides;
}

function parseRustOverrides(
	value: unknown,
	issues: KeybindingConfigIssue[],
): Partial<Record<RustTuiKeybindingAction, RustTuiKeybindingShortcut>> {
	if (value === undefined) {
		return {};
	}
	if (!isPlainObject(value)) {
		issues.push({
			severity: "error",
			message:
				'"rustBindings" must be an object of action-to-shortcut overrides.',
		});
		return {};
	}

	const overrides: Partial<
		Record<RustTuiKeybindingAction, RustTuiKeybindingShortcut>
	> = {};
	for (const [rawAction, rawShortcut] of Object.entries(value)) {
		const action = normalizeActionName(rawAction);
		if (!isRustAction(action)) {
			issues.push({
				severity: "error",
				message: `Unknown Rust TUI keybinding action "${rawAction}". Supported actions: ${RUST_TUI_KEYBINDING_ACTIONS.join(", ")}.`,
			});
			continue;
		}
		if (typeof rawShortcut !== "string") {
			issues.push({
				severity: "error",
				message: `Rust TUI action "${action}" must map to a shortcut string.`,
			});
			continue;
		}
		const shortcut = normalizeShortcutName(rawShortcut);
		if (!isRustShortcut(shortcut)) {
			issues.push({
				severity: "error",
				message: `Unsupported Rust TUI shortcut "${rawShortcut}" for "${action}". Supported shortcuts: ${RUST_TUI_KEYBINDING_SHORTCUTS.join(", ")}.`,
			});
			continue;
		}
		overrides[action] = shortcut;
	}
	return overrides;
}

function collectTuiConflictIssues(
	overrides: Partial<Record<TuiKeybindingAction, TuiKeybindingShortcut>>,
	env: NodeJS.ProcessEnv,
): KeybindingConfigIssue[] {
	const defaults = Object.fromEntries(
		TUI_KEYBINDING_ACTIONS.map((action) => [
			action,
			getDefaultTuiKeybindingShortcut(action, env),
		]),
	) as Record<TuiKeybindingAction, TuiKeybindingShortcut>;
	const resolved = { ...defaults, ...overrides };
	const issues: KeybindingConfigIssue[] = [];
	const seen = new Set<string>();
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

		for (const [shortcut, actions] of actionsByShortcut.entries()) {
			if (actions.length < 2) {
				continue;
			}
			for (const action of actions) {
				if (!Object.prototype.hasOwnProperty.call(overrides, action)) {
					continue;
				}
				if (resolved[action] === defaults[action]) {
					continue;
				}
				const key = `${action}:${shortcut}`;
				if (!seen.has(key)) {
					issues.push({
						severity: "warning",
						message: `TUI override "${action}: ${shortcut}" conflicts with ${actions
							.filter((candidate) => candidate !== action)
							.join(", ")} and falls back to ${defaults[action]}.`,
					});
					seen.add(key);
				}
				resolved[action] = defaults[action];
				changed = true;
			}
		}
	}

	return issues;
}

function collectRustConflictIssues(
	overrides: Partial<
		Record<RustTuiKeybindingAction, RustTuiKeybindingShortcut>
	>,
	env: NodeJS.ProcessEnv,
): KeybindingConfigIssue[] {
	const defaults = buildDefaultRustBindings(env);
	const resolved = { ...defaults, ...overrides };
	const issues: KeybindingConfigIssue[] = [];
	const seen = new Set<string>();
	let changed = true;

	while (changed) {
		changed = false;
		const actionsByShortcut = new Map<
			RustTuiKeybindingShortcut,
			RustTuiKeybindingAction[]
		>();
		for (const action of RUST_TUI_KEYBINDING_ACTIONS) {
			const shortcut = resolved[action];
			const actions = actionsByShortcut.get(shortcut) ?? [];
			actions.push(action);
			actionsByShortcut.set(shortcut, actions);
		}

		for (const [shortcut, actions] of actionsByShortcut.entries()) {
			if (actions.length < 2) {
				continue;
			}
			for (const action of actions) {
				if (!Object.prototype.hasOwnProperty.call(overrides, action)) {
					continue;
				}
				if (resolved[action] === defaults[action]) {
					continue;
				}
				const key = `${action}:${shortcut}`;
				if (!seen.has(key)) {
					issues.push({
						severity: "warning",
						message: `Rust TUI override "${action}: ${shortcut}" conflicts with ${actions
							.filter((candidate) => candidate !== action)
							.join(", ")} and falls back to ${defaults[action]}.`,
					});
					seen.add(key);
				}
				resolved[action] = defaults[action];
				changed = true;
			}
		}
	}

	return issues;
}

export function inspectKeybindingConfig(
	env: NodeJS.ProcessEnv = process.env,
): KeybindingConfigReport {
	const path = getTuiKeybindingsFilePath(env);
	if (!fileExists(path)) {
		return {
			path,
			exists: false,
			tuiRequestedOverrides: 0,
			tuiActiveOverrides: 0,
			rustRequestedOverrides: 0,
			rustActiveOverrides: 0,
			issues: [],
		};
	}
	try {
		const content = readTextFile(path);
		const issues: KeybindingConfigIssue[] = [];
		const parsed = safeJsonParse<ParsedKeybindingConfig>(content, path);
		if (!parsed.success) {
			return {
				path,
				exists: true,
				tuiRequestedOverrides: 0,
				tuiActiveOverrides: 0,
				rustRequestedOverrides: 0,
				rustActiveOverrides: 0,
				issues: [
					{
						severity: "error",
						message:
							parsed.error.cause?.message ??
							"Failed to parse keybindings.json.",
					},
				],
			};
		}
		if (!isPlainObject(parsed.data)) {
			return {
				path,
				exists: true,
				tuiRequestedOverrides: 0,
				tuiActiveOverrides: 0,
				rustRequestedOverrides: 0,
				rustActiveOverrides: 0,
				issues: [
					{
						severity: "error",
						message: "keybindings.json must contain a JSON object.",
					},
				],
			};
		}

		if (parsed.data.version !== 1) {
			issues.push({
				severity: "error",
				message: 'keybindings.json must include `"version": 1`.',
			});
		}

		const tuiOverrides = parseTuiOverrides(parsed.data.bindings, issues);
		const rustOverrides = parseRustOverrides(parsed.data.rustBindings, issues);
		issues.push(...collectTuiConflictIssues(tuiOverrides, env));
		issues.push(...collectRustConflictIssues(rustOverrides, env));

		const activeTuiOverrides = Object.entries(tuiOverrides).filter(
			([action, shortcut]) =>
				getResolvedTuiKeybindings(env)[action as TuiKeybindingAction] ===
				shortcut,
		).length;

		const rustDefaults = buildDefaultRustBindings(env);
		const activeRustOverrides = Object.entries(rustOverrides).filter(
			([action, shortcut]) =>
				rustDefaults[action as RustTuiKeybindingAction] !== shortcut,
		).length;

		return {
			path,
			exists: true,
			tuiRequestedOverrides: Object.keys(tuiOverrides).length,
			tuiActiveOverrides: activeTuiOverrides,
			rustRequestedOverrides: Object.keys(rustOverrides).length,
			rustActiveOverrides: activeRustOverrides,
			issues,
		};
	} catch {
		return {
			path,
			exists: true,
			tuiRequestedOverrides: 0,
			tuiActiveOverrides: 0,
			rustRequestedOverrides: 0,
			rustActiveOverrides: 0,
			issues: [
				{
					severity: "error",
					message: "Failed to read keybindings.json.",
				},
			],
		};
	}
}

export function generateKeybindingsTemplate(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const bindings = Object.fromEntries(
		TUI_KEYBINDING_ACTIONS.map((action) => [
			action,
			getDefaultTuiKeybindingShortcut(action, env),
		]),
	);
	const rustBindings = buildDefaultRustBindings(env);
	return `${JSON.stringify(
		{
			$docs: "https://github.com/evalops/maestro",
			$comment:
				"Delete any entries you do not want to override, then run /hotkeys validate inside Maestro.",
			version: 1,
			bindings,
			rustBindings,
		},
		null,
		2,
	)}\n`;
}

export function initializeKeybindingsFile(options?: {
	env?: NodeJS.ProcessEnv;
	force?: boolean;
}): { path: string; created: boolean } {
	const env = options?.env ?? process.env;
	const path = getTuiKeybindingsFilePath(env);
	const report = inspectKeybindingConfig(env);
	if (report.exists && !options?.force) {
		return { path, created: false };
	}
	writeTextFile(path, generateKeybindingsTemplate(env));
	return { path, created: true };
}

export function formatKeybindingConfigReport(
	report: KeybindingConfigReport,
): string {
	const lines = ["Keyboard Shortcuts Config:"];
	lines.push(`  Path: ${report.path}`);
	lines.push(`  Status: ${report.exists ? "present" : "missing"}`);
	if (!report.exists) {
		lines.push("  Hint: run /hotkeys init to create a starter file.");
		return lines.join("\n");
	}
	lines.push(
		`  TUI overrides: ${report.tuiActiveOverrides}/${report.tuiRequestedOverrides} active`,
	);
	lines.push(
		`  Rust TUI overrides: ${report.rustActiveOverrides}/${report.rustRequestedOverrides} active`,
	);
	if (report.issues.length === 0) {
		lines.push("  Validation: OK");
		return lines.join("\n");
	}
	lines.push(`  Issues: ${report.issues.length}`);
	for (const issue of report.issues) {
		lines.push(`  - ${issue.severity.toUpperCase()}: ${issue.message}`);
	}
	return lines.join("\n");
}
