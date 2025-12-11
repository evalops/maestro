/**
 * Split long text into Slack-safe message chunks.
 *
 * Slack hard limit is ~40k chars; we split on paragraph/newline/space boundaries
 * and add a small continuation suffix for intermediate chunks.
 */
export function splitForSlack(
	text: string,
	options: { maxLength?: number; suffixPadding?: number } = {},
): string[] {
	const maxLength = options.maxLength ?? 40000;
	const suffixPadding = options.suffixPadding ?? 50;

	if (text.length <= maxLength) return [text];

	const parts: string[] = [];
	let remaining = text;
	let partNum = 1;
	const maxChunk = maxLength - suffixPadding;

	while (remaining.length > 0) {
		if (remaining.length <= maxChunk) {
			parts.push(remaining);
			break;
		}

		let cut = maxChunk;
		const window = remaining.slice(0, maxChunk);
		const breakCandidates = [
			window.lastIndexOf("\n\n"),
			window.lastIndexOf("\n"),
			window.lastIndexOf(" "),
		].filter((i) => i > -1);
		const preferred = breakCandidates.find((i) => i >= maxChunk * 0.6);
		if (preferred !== undefined) {
			cut = preferred;
		}

		const chunk = remaining.slice(0, cut);
		remaining = remaining.slice(cut);
		const suffix = remaining.length > 0 ? `\n_(continued ${partNum}...)_` : "";
		parts.push(chunk + suffix);
		partNum++;
	}

	return parts;
}
