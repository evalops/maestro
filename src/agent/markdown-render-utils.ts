/**
 * Shared markdown helpers for agent-facing renderers.
 */
export function renderInlineCode(input: string): string {
	const normalized = input.replace(/\r?\n|\r/g, " ");
	const longestBacktickRun = Math.max(
		0,
		...[...normalized.matchAll(/`+/g)].map((match) => match[0].length),
	);
	const fence = "`".repeat(longestBacktickRun + 1);
	const body =
		normalized.startsWith("`") || normalized.endsWith("`")
			? ` ${normalized} `
			: normalized;
	return `${fence}${body}${fence}`;
}
