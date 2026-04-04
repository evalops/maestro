import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

type DirectoryEntryMatcher = (entry: string) => boolean;

export function buildDirectoryFingerprint(
	dir: string,
	matchEntry: DirectoryEntryMatcher,
): string {
	if (!existsSync(dir)) {
		return `${dir}:missing`;
	}

	try {
		const entries = readdirSync(dir).filter(matchEntry).sort();
		const parts = [dir];
		for (const entry of entries) {
			const entryPath = join(dir, entry);
			try {
				const stat = statSync(entryPath);
				if (!stat.isFile() && !stat.isSymbolicLink()) {
					continue;
				}
				parts.push(`${entry}:${stat.size}:${stat.mtimeMs}`);
			} catch {
				parts.push(`${entry}:unreadable`);
			}
		}
		return parts.join("|");
	} catch {
		return `${dir}:unreadable`;
	}
}

export function buildDirectoriesFingerprint(
	dirs: string[],
	matchEntry: DirectoryEntryMatcher,
): string {
	return dirs
		.map((dir) => buildDirectoryFingerprint(dir, matchEntry))
		.join("::");
}
