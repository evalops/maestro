/**
 * Escape a string for safe use in shell commands.
 * Wraps in single quotes and escapes embedded single quotes.
 */
export function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}
