import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT_MARKERS = [
	"package.json",
	"pnpm-workspace.yaml",
	"pnpm-lock.yaml",
	"yarn.lock",
	"lerna.json",
	"turbo.json",
	"nx.json",
	"tsconfig.json",
	"pyproject.toml",
	"requirements.txt",
	"poetry.lock",
	"go.mod",
	"Cargo.toml",
	"composer.json",
	".git",
];

const cache = new Map<string, string | null>();

export type ResolveWorkspaceRootOptions = {
	stopAt?: string;
};

export async function resolveWorkspaceRoot(
	filePath: string,
	options: ResolveWorkspaceRootOptions = {},
): Promise<string | undefined> {
	const absolute = resolve(filePath);
	const startDir = dirname(absolute);
	const stopDir = options.stopAt ? resolve(options.stopAt) : undefined;
	const startCacheKey = workspaceRootCacheKey(startDir, stopDir);
	const cached = cache.get(startCacheKey);
	if (cached !== undefined) {
		return cached ?? undefined;
	}
	let current = startDir;
	while (true) {
		const currentCacheKey = workspaceRootCacheKey(current, stopDir);
		const cachedCandidate = cache.get(currentCacheKey);
		if (cachedCandidate !== undefined) {
			cache.set(startCacheKey, cachedCandidate);
			return cachedCandidate ?? undefined;
		}
		if (hasMarker(current)) {
			cache.set(startCacheKey, current);
			return current;
		}
		if (stopDir && current === stopDir) {
			cache.set(startCacheKey, null);
			return undefined;
		}
		const parent = dirname(current);
		if (parent === current) {
			cache.set(startCacheKey, null);
			return undefined;
		}
		current = parent;
	}
}

function hasMarker(dir: string): boolean {
	return ROOT_MARKERS.some((marker) => existsSync(join(dir, marker)));
}

function workspaceRootCacheKey(
	dir: string,
	stopDir: string | undefined,
): string {
	return stopDir ? `${dir}\0${stopDir}` : dir;
}

export function resetWorkspaceRootCacheForTests(): void {
	cache.clear();
}
