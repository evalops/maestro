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

export async function resolveWorkspaceRoot(
	filePath: string,
): Promise<string | undefined> {
	const absolute = resolve(filePath);
	const startDir = dirname(absolute);
	const cached = cache.get(startDir);
	if (cached !== undefined) {
		return cached ?? undefined;
	}
	let current = startDir;
	while (true) {
		const cachedCandidate = cache.get(current);
		if (cachedCandidate !== undefined) {
			cache.set(startDir, cachedCandidate);
			return cachedCandidate ?? undefined;
		}
		if (hasMarker(current)) {
			cache.set(startDir, current);
			return current;
		}
		const parent = dirname(current);
		if (parent === current) {
			cache.set(startDir, null);
			return undefined;
		}
		current = parent;
	}
}

function hasMarker(dir: string): boolean {
	return ROOT_MARKERS.some((marker) => existsSync(join(dir, marker)));
}

export function resetWorkspaceRootCacheForTests(): void {
	cache.clear();
}
