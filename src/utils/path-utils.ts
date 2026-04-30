export function uniquePaths(
	paths: ReadonlyArray<string | null | undefined>,
): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const path of paths) {
		if (!path || seen.has(path)) continue;
		seen.add(path);
		result.push(path);
	}
	return result;
}
