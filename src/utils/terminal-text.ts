/**
 * Terminal-safe text helpers that do not depend on the removed TypeScript TUI.
 * Used by CLI previews (e.g. `maestro agents init` diff preview).
 */

const ANSI_STRING_TERMINATORS = "(?:\\u0007|\\u001B\\u005C|\\u009C)";
const ANSI_OSC_SEQUENCE = `(?:\\u001B\\][\\s\\S]*?${ANSI_STRING_TERMINATORS})`;
const ANSI_CSI_SEQUENCE =
	"[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]";
const ANSI_ESCAPE_SEQUENCE = new RegExp(
	`${ANSI_OSC_SEQUENCE}|${ANSI_CSI_SEQUENCE}`,
	"g",
);

export function stripAnsiSequences(text: string): string {
	return text.replace(ANSI_ESCAPE_SEQUENCE, "");
}

/**
 * Strip ANSI and other control characters so repository text can be printed
 * safely to a terminal without escaping or mode-setting sequences.
 */
export function sanitizeTerminalPreview(text: string): string {
	return stripAnsiSequences(text).replace(
		// biome-ignore lint/suspicious/noControlCharactersInRegex: preview text may come from repository files and must not emit terminal controls.
		/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,
		"",
	);
}
