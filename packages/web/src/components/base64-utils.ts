export function normalizeBase64(input: string): string {
	return input.replace(/\s+/g, "");
}

export function isValidBase64(input: string): boolean {
	if (!input) return false;
	if (input.length % 4 !== 0) return false;
	return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
		input,
	);
}
