import { homedir } from "node:os";
import { join } from "node:path";

export function getOsHomeDir(): string {
	return homedir();
}

export function getHomeDir(): string {
	return (
		process.env.HOME?.trim() ||
		process.env.USERPROFILE?.trim() ||
		getOsHomeDir()
	);
}

export function expandTildePathWithHomeDir(
	path: string,
	homeDir: string,
): string {
	if (path === "~") return homeDir;
	if (path.startsWith("~/")) return join(homeDir, path.slice(2));
	if (path.startsWith("~")) return join(homeDir, path.slice(1));
	return path;
}

/**
 * Expand leading `~` to the current user's home directory.
 *
 * - `~` -> `/home/user`
 * - `~/path` -> `/home/user/path`
 * - `~path` -> `/home/user/path` (compat with some callers)
 */
export function expandTildePath(path: string): string {
	return expandTildePathWithHomeDir(path, getHomeDir());
}
