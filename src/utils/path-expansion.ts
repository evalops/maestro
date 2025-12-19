import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
	if (path.startsWith("~/") || path.startsWith("~\\")) {
		return join(homeDir, path.slice(2));
	}
	return path;
}

/**
 * Expand leading `~` to the current user's home directory.
 *
 * - `~` -> `/home/user`
 * - `~/path` -> `/home/user/path`
 */
export function expandTildePath(path: string): string {
	return expandTildePathWithHomeDir(path, getHomeDir());
}

export function resolveEnvPath(value?: string | null): string | null {
	const trimmed = value?.trim();
	if (!trimmed) return null;
	return resolve(expandTildePath(trimmed));
}
