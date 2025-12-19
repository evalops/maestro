/**
 * Declarative keymap system for terminal keyboard handling.
 *
 * ## Kitty Keyboard Protocol Support
 *
 * The Kitty keyboard protocol sends enhanced escape sequences in the format:
 *   \x1b[<codepoint>;<modifier>u
 *
 * Modifier values (added to 1):
 *   - Shift: 1 (value 2)
 *   - Alt: 2 (value 3)
 *   - Ctrl: 4 (value 5)
 *   - Super: 8 (value 9)
 *
 * See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
 */

export interface KeyBinding<TContext = unknown> {
	keys: string[];
	handler: (context: TContext) => void;
	description: string;
	when?: (context: TContext) => boolean;
	priority?: number;
}

export const ControlCodes = {
	CTRL_A: 1,
	CTRL_B: 2,
	CTRL_C: 3,
	CTRL_D: 4,
	CTRL_E: 5,
	CTRL_F: 6,
	CTRL_G: 7,
	CTRL_H: 8,
	CTRL_I: 9,
	CTRL_J: 10,
	CTRL_K: 11,
	CTRL_L: 12,
	CTRL_M: 13,
	CTRL_N: 14,
	CTRL_O: 15,
	CTRL_P: 16,
	CTRL_Q: 17,
	CTRL_R: 18,
	CTRL_S: 19,
	CTRL_T: 20,
	CTRL_U: 21,
	CTRL_V: 22,
	CTRL_W: 23,
	CTRL_X: 24,
	CTRL_Y: 25,
	CTRL_Z: 26,
	ESCAPE: 27,
	BACKSPACE: 127,
} as const;

export const AnsiKeys = {
	UP: "\x1b[A",
	DOWN: "\x1b[B",
	RIGHT: "\x1b[C",
	LEFT: "\x1b[D",
	UP_SS3: "\x1bOA",
	DOWN_SS3: "\x1bOB",
	RIGHT_SS3: "\x1bOC",
	LEFT_SS3: "\x1bOD",
	CTRL_LEFT: "\x1b[1;5D",
	CTRL_RIGHT: "\x1b[1;5C",
	CTRL_LEFT_ALT: "\x1b[5D",
	CTRL_RIGHT_ALT: "\x1b[5C",
	ALT_LEFT: "\x1b[1;3D",
	ALT_RIGHT: "\x1b[1;3C",
	HOME: "\x1b[H",
	HOME_ALT1: "\x1b[1~",
	HOME_ALT2: "\x1b[7~",
	END: "\x1b[F",
	END_ALT1: "\x1b[4~",
	END_ALT2: "\x1b[8~",
	DELETE: "\x1b[3~",
	ALT_B: "\x1bb",
	ALT_F: "\x1bf",
	ALT_Y: "\x1by",
	ALT_BACKSPACE: "\x1b\x7f",
	PASTE_START: "\x1b[200~",
	PASTE_END: "\x1b[201~",
	SHIFT_TAB: "\x1b[Z",
} as const;

// =============================================================================
// Kitty Keyboard Protocol
// =============================================================================

// Codepoints for common keys
const KITTY_CODEPOINTS = {
	a: 97,
	c: 99,
	d: 100,
	e: 101,
	k: 107,
	o: 111,
	p: 112,
	t: 116,
	u: 117,
	w: 119,
	tab: 9,
	enter: 13,
	backspace: 127,
} as const;

// Modifier bits (before adding 1 per Kitty protocol spec)
const KITTY_MODIFIERS = {
	shift: 1,
	alt: 2,
	ctrl: 4,
	super: 8,
} as const;

/**
 * Build a Kitty keyboard protocol sequence for a key with modifier.
 */
function kittySequence(codepoint: number, modifier: number): string {
	return `\x1b[${codepoint};${modifier + 1}u`;
}

/**
 * Kitty keyboard protocol sequences for modern terminals.
 * These are the enhanced escape sequences that terminals like Kitty, WezTerm,
 * and others send when the Kitty keyboard protocol is enabled.
 */
export const KittyKeys = {
	// Ctrl+<letter> combinations
	CTRL_A: kittySequence(KITTY_CODEPOINTS.a, KITTY_MODIFIERS.ctrl),
	CTRL_C: kittySequence(KITTY_CODEPOINTS.c, KITTY_MODIFIERS.ctrl),
	CTRL_D: kittySequence(KITTY_CODEPOINTS.d, KITTY_MODIFIERS.ctrl),
	CTRL_E: kittySequence(KITTY_CODEPOINTS.e, KITTY_MODIFIERS.ctrl),
	CTRL_K: kittySequence(KITTY_CODEPOINTS.k, KITTY_MODIFIERS.ctrl),
	CTRL_O: kittySequence(KITTY_CODEPOINTS.o, KITTY_MODIFIERS.ctrl),
	CTRL_P: kittySequence(KITTY_CODEPOINTS.p, KITTY_MODIFIERS.ctrl),
	CTRL_T: kittySequence(KITTY_CODEPOINTS.t, KITTY_MODIFIERS.ctrl),
	CTRL_U: kittySequence(KITTY_CODEPOINTS.u, KITTY_MODIFIERS.ctrl),
	CTRL_W: kittySequence(KITTY_CODEPOINTS.w, KITTY_MODIFIERS.ctrl),

	// Enter combinations
	SHIFT_ENTER: kittySequence(KITTY_CODEPOINTS.enter, KITTY_MODIFIERS.shift),
	ALT_ENTER: kittySequence(KITTY_CODEPOINTS.enter, KITTY_MODIFIERS.alt),
	CTRL_ENTER: kittySequence(KITTY_CODEPOINTS.enter, KITTY_MODIFIERS.ctrl),

	// Tab combinations
	SHIFT_TAB: kittySequence(KITTY_CODEPOINTS.tab, KITTY_MODIFIERS.shift),

	// Backspace combinations
	ALT_BACKSPACE: kittySequence(KITTY_CODEPOINTS.backspace, KITTY_MODIFIERS.alt),
} as const;

// Raw control character codes (for comparison with KittyKeys)
const RAW_KEYS = {
	CTRL_A: "\x01",
	CTRL_C: "\x03",
	CTRL_D: "\x04",
	CTRL_E: "\x05",
	CTRL_K: "\x0b",
	CTRL_O: "\x0f",
	CTRL_P: "\x10",
	CTRL_T: "\x14",
	CTRL_U: "\x15",
	CTRL_W: "\x17",
	ALT_BACKSPACE: "\x1b\x7f",
	SHIFT_TAB: "\x1b[Z",
} as const;

/**
 * Check if input matches Ctrl+A (raw byte or Kitty protocol).
 */
export function isCtrlA(data: string): boolean {
	return data === RAW_KEYS.CTRL_A || data === KittyKeys.CTRL_A;
}

/**
 * Check if input matches Ctrl+C (raw byte or Kitty protocol).
 */
export function isCtrlC(data: string): boolean {
	return data === RAW_KEYS.CTRL_C || data === KittyKeys.CTRL_C;
}

/**
 * Check if input matches Ctrl+D (raw byte or Kitty protocol).
 */
export function isCtrlD(data: string): boolean {
	return data === RAW_KEYS.CTRL_D || data === KittyKeys.CTRL_D;
}

/**
 * Check if input matches Ctrl+E (raw byte or Kitty protocol).
 */
export function isCtrlE(data: string): boolean {
	return data === RAW_KEYS.CTRL_E || data === KittyKeys.CTRL_E;
}

/**
 * Check if input matches Ctrl+K (raw byte or Kitty protocol).
 */
export function isCtrlK(data: string): boolean {
	return data === RAW_KEYS.CTRL_K || data === KittyKeys.CTRL_K;
}

/**
 * Check if input matches Ctrl+O (raw byte or Kitty protocol).
 */
export function isCtrlO(data: string): boolean {
	return data === RAW_KEYS.CTRL_O || data === KittyKeys.CTRL_O;
}

/**
 * Check if input matches Ctrl+P (raw byte or Kitty protocol).
 */
export function isCtrlP(data: string): boolean {
	return data === RAW_KEYS.CTRL_P || data === KittyKeys.CTRL_P;
}

/**
 * Check if input matches Ctrl+T (raw byte or Kitty protocol).
 */
export function isCtrlT(data: string): boolean {
	return data === RAW_KEYS.CTRL_T || data === KittyKeys.CTRL_T;
}

/**
 * Check if input matches Ctrl+U (raw byte or Kitty protocol).
 */
export function isCtrlU(data: string): boolean {
	return data === RAW_KEYS.CTRL_U || data === KittyKeys.CTRL_U;
}

/**
 * Check if input matches Ctrl+W (raw byte or Kitty protocol).
 */
export function isCtrlW(data: string): boolean {
	return data === RAW_KEYS.CTRL_W || data === KittyKeys.CTRL_W;
}

/**
 * Check if input matches Alt+Backspace (legacy or Kitty protocol).
 */
export function isAltBackspace(data: string): boolean {
	return data === RAW_KEYS.ALT_BACKSPACE || data === KittyKeys.ALT_BACKSPACE;
}

/**
 * Check if input matches Shift+Tab (legacy or Kitty protocol).
 */
export function isShiftTab(data: string): boolean {
	return data === RAW_KEYS.SHIFT_TAB || data === KittyKeys.SHIFT_TAB;
}

/**
 * Check if input matches Shift+Enter (Kitty protocol only).
 */
export function isShiftEnter(data: string): boolean {
	return data === KittyKeys.SHIFT_ENTER;
}

/**
 * Check if input matches Alt+Enter (Kitty protocol only).
 */
export function isAltEnter(data: string): boolean {
	return data === KittyKeys.ALT_ENTER;
}

export class Keymap<TContext = unknown> {
	private bindings: KeyBinding<TContext>[] = [];
	private sortedBindings: KeyBinding<TContext>[] | null = null;

	register(binding: KeyBinding<TContext>): this {
		this.bindings.push(binding);
		this.sortedBindings = null;
		return this;
	}

	registerAll(bindings: KeyBinding<TContext>[]): this {
		for (const binding of bindings) this.register(binding);
		return this;
	}

	getBindings(): KeyBinding<TContext>[] {
		if (!this.sortedBindings) {
			this.sortedBindings = [...this.bindings].sort(
				(a, b) => (b.priority ?? 0) - (a.priority ?? 0),
			);
		}
		return this.sortedBindings;
	}

	handle(key: string, context: TContext): boolean {
		for (const binding of this.getBindings()) {
			if (binding.when && !binding.when(context)) continue;
			for (const pattern of binding.keys) {
				if (
					key === pattern ||
					(key.length === 1 &&
						pattern.length === 1 &&
						key.charCodeAt(0) === pattern.charCodeAt(0))
				) {
					binding.handler(context);
					return true;
				}
			}
		}
		return false;
	}

	findMatching(key: string, context: TContext): KeyBinding<TContext>[] {
		return this.getBindings().filter((binding) => {
			if (binding.when && !binding.when(context)) return false;
			return binding.keys.some((pattern) => key === pattern);
		});
	}

	getActiveBindings(context: TContext): KeyBinding<TContext>[] {
		return this.getBindings().filter((b) => !b.when || b.when(context));
	}

	generateHelp(context?: TContext): string[] {
		const bindings = context
			? this.getActiveBindings(context)
			: this.getBindings();
		return bindings.map((b) => {
			const keys = b.keys.map((k) => formatKey(k)).join(", ");
			return `${keys.padEnd(20)} ${b.description}`;
		});
	}
}

export function ctrl(code: number): string {
	return String.fromCharCode(code);
}

function formatKey(key: string): string {
	if (key.length === 1) {
		const code = key.charCodeAt(0);
		if (code >= 1 && code <= 26)
			return `Ctrl+${String.fromCharCode(code + 64)}`;
		if (code === 27) return "Escape";
		if (code === 127) return "Backspace";
		if (code === 13) return "Enter";
		if (code === 9) return "Tab";
	}
	const names: Record<string, string> = {
		[AnsiKeys.UP]: "Up",
		[AnsiKeys.DOWN]: "Down",
		[AnsiKeys.LEFT]: "Left",
		[AnsiKeys.RIGHT]: "Right",
		[AnsiKeys.HOME]: "Home",
		[AnsiKeys.END]: "End",
		[AnsiKeys.DELETE]: "Delete",
		[AnsiKeys.ALT_B]: "Alt+B",
		[AnsiKeys.ALT_F]: "Alt+F",
		[AnsiKeys.ALT_Y]: "Alt+Y",
	};
	return names[key] ?? (key.startsWith("\x1b") ? `ESC+${key.slice(1)}` : key);
}
