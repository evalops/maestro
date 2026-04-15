import { fileURLToPath, pathToFileURL } from "node:url";

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
	if (path.startsWith("file://")) {
		return path;
	}
	return pathToFileURL(path).toString();
}

/**
 * Convert LSP URI to file path
 */
export function uriToPath(uri: string): string {
	if (uri.startsWith("file://")) {
		try {
			return fileURLToPath(uri);
		} catch {
			let path = uri.slice(7);
			// Remove leading slash for Windows drive-letter paths (e.g., "/C:/...")
			if (path.length >= 3 && path[0] === "/" && path[2] === ":") {
				path = path.slice(1);
			}
			return path;
		}
	}
	return uri;
}
