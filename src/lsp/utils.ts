/**
 * Check if an error indicates a dead connection
 */
export function isConnectionDead(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const err = error as { code?: string; message?: string };
	return (
		err.code === "EPIPE" ||
		(err.message?.includes("socket") ?? false) ||
		(err.message?.includes("ended by the other party") ?? false)
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
