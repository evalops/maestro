export function approximateTokensFromText(text: string): number {
	// Rough heuristic: 1 token ≈ 4 chars, with minimum floor at 1
	return Math.max(1, Math.round(text.length / 4));
}

export function approximateTokensFromJson(value: unknown): number {
	try {
		return approximateTokensFromText(JSON.stringify(value));
	} catch {
		return 0;
	}
}
