/**
 * OSC-8 hyperlink helper with graceful fallback for terminals that don't support it.
 */
const OSC8_START = "\u001b]8;;";
const OSC8_END = "\u001b]8;;\u0007";
const OSC8_TERM = "\u0007";

export function formatLink(url: string, label?: string): string {
	const text = label ?? url;
	// If stdout isn't a TTY, just return plain text.
	if (!process.stdout.isTTY) return `${text} (${url})`;
	return `${OSC8_START}${url}${OSC8_TERM}${text}${OSC8_END}`;
}
