/**
 * Declarative keymap system for terminal keyboard handling.
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
} as const;

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
