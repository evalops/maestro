/**
 * Check if an error indicates a dead connection
 */
export function isConnectionDead(error: unknown): boolean {
	const err = error as any;
	return (
		err?.code === "EPIPE" ||
		err?.message?.includes("socket") ||
		err?.message?.includes("ended by the other party")
	);
}

/**
 * Convert file path to LSP URI
 */
export function pathToUri(path: string): string {
	// Normalize path and convert to file:// URI
	const normalized = path.replace(/\\/g, "/");
	return normalized.startsWith("file://")
		? normalized
		: `file://${normalized.startsWith("/") ? "" : "/"}${normalized}`;
}

/**
 * Convert LSP URI to file path
 */
export function uriToPath(uri: string): string {
	if (uri.startsWith("file://")) {
		return uri.slice(7);
	}
	return uri;
}
