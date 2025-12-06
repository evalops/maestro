/**
 * Input Handler for Native TUI
 *
 * Converts key events from Rust TUI format to the format
 * expected by the existing TUI components.
 */

import type { KeyModifiers } from "./protocol.js";

/**
 * Convert a key event from Rust TUI to the ANSI escape sequence
 * or character that our components expect.
 */
export function keyToAnsi(key: string, modifiers: KeyModifiers): string {
	const { ctrl, alt, shift } = modifiers;

	// Handle control characters
	if (ctrl) {
		// Ctrl+letter produces control character (1-26)
		if (key.length === 1 && key >= "a" && key <= "z") {
			const code = key.charCodeAt(0) - 96; // 'a' = 1, 'z' = 26
			return String.fromCharCode(code);
		}
		if (key.length === 1 && key >= "A" && key <= "Z") {
			const code = key.toLowerCase().charCodeAt(0) - 96;
			return String.fromCharCode(code);
		}

		// Special Ctrl combinations
		switch (key) {
			case "Up":
				return "\x1b[1;5A";
			case "Down":
				return "\x1b[1;5B";
			case "Right":
				return "\x1b[1;5C";
			case "Left":
				return "\x1b[1;5D";
			case "Home":
				return "\x1b[1;5H";
			case "End":
				return "\x1b[1;5F";
		}
	}

	// Handle Alt combinations
	if (alt) {
		if (key.length === 1) {
			return `\x1b${key}`;
		}
	}

	// Handle special keys
	switch (key) {
		case "Enter":
			return shift ? "\x1b[13;2u" : "\r";
		case "Backspace":
			return "\x7f";
		case "Delete":
			return "\x1b[3~";
		case "Tab":
			return shift ? "\x1b[Z" : "\t";
		case "Escape":
			return "\x1b";
		case "Up":
			return "\x1b[A";
		case "Down":
			return "\x1b[B";
		case "Right":
			return "\x1b[C";
		case "Left":
			return "\x1b[D";
		case "Home":
			return "\x1b[H";
		case "End":
			return "\x1b[F";
		case "PageUp":
			return "\x1b[5~";
		case "PageDown":
			return "\x1b[6~";
		case "Insert":
			return "\x1b[2~";
		case "F1":
			return "\x1bOP";
		case "F2":
			return "\x1bOQ";
		case "F3":
			return "\x1bOR";
		case "F4":
			return "\x1bOS";
		case "F5":
			return "\x1b[15~";
		case "F6":
			return "\x1b[17~";
		case "F7":
			return "\x1b[18~";
		case "F8":
			return "\x1b[19~";
		case "F9":
			return "\x1b[20~";
		case "F10":
			return "\x1b[21~";
		case "F11":
			return "\x1b[23~";
		case "F12":
			return "\x1b[24~";
		default:
			// Regular character
			if (key.length === 1) {
				return key;
			}
			return "";
	}
}

/**
 * Parse key name from our format
 */
export function parseKeyName(key: string): {
	name: string;
	char?: string;
} {
	if (key.length === 1) {
		return { name: "char", char: key };
	}
	return { name: key.toLowerCase() };
}

/**
 * Check if a key event represents a printable character
 */
export function isPrintable(key: string, modifiers: KeyModifiers): boolean {
	if (modifiers.ctrl || modifiers.alt || modifiers.meta) {
		return false;
	}
	return key.length === 1 && key >= " ";
}
