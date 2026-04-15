const HEADLESS_OUTPUT_LIMIT = 32_768;

export function appendHeadlessOutput(existing: string, chunk: string): string {
	const next = `${existing}${chunk}`;
	if (next.length <= HEADLESS_OUTPUT_LIMIT) {
		return next;
	}
	return next.slice(next.length - HEADLESS_OUTPUT_LIMIT);
}
