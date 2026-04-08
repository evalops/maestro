import {
	type ConfiguredPackageSpec,
	type WritablePackageScope,
	loadConfiguredPackageSpecs,
} from "../config/toml-config.js";
import {
	type InspectedPackage,
	collectPackageValidationIssues,
	inspectPackageSource,
} from "./inspection.js";
import { parsePackageSpec } from "./loader.js";
import {
	clearCachedPackageSourcePath,
	formatPackageSource,
	getCachedRemotePackageSourcePath,
	getPackageCacheDir,
	listCachedRemotePackageSourcePaths,
	parsePackageSource,
	refreshPackageSourceSync,
} from "./sources.js";
import type { GitSource, NpmSource } from "./types.js";

export interface RefreshedConfiguredPackage {
	source: string;
	sourceType: "git" | "npm";
	scopes: WritablePackageScope[];
	inspection: InspectedPackage | null;
	issues: string[];
	error: string | null;
}

export interface ConfiguredPackageRefreshReport {
	refreshed: RefreshedConfiguredPackage[];
	localCount: number;
	remoteCount: number;
}

export interface PackageCachePruneReport {
	cacheDir: string;
	removed: string[];
	removedCount: number;
	referencedCount: number;
}

interface RemoteRefreshTarget {
	sourceSpec: string;
	cwd: string;
	source: GitSource | NpmSource;
	scopes: Set<WritablePackageScope>;
}

function compareScope(
	left: WritablePackageScope,
	right: WritablePackageScope,
): number {
	const order: Record<WritablePackageScope, number> = {
		local: 0,
		project: 1,
		user: 2,
	};
	return order[left] - order[right];
}

function resolveConfiguredSourceSpec(entry: ConfiguredPackageSpec): string {
	return parsePackageSpec(entry.spec, entry.cwd)[0];
}

function collectRemoteRefreshTargets(workspaceDir: string): {
	localCount: number;
	targets: RemoteRefreshTarget[];
} {
	const targets = new Map<string, RemoteRefreshTarget>();
	let localCount = 0;

	for (const entry of loadConfiguredPackageSpecs(workspaceDir)) {
		const sourceSpec = resolveConfiguredSourceSpec(entry);
		const source = parsePackageSource(sourceSpec, entry.cwd);
		if (source.type === "local") {
			localCount += 1;
			continue;
		}

		const identity = formatPackageSource(source);
		const existing = targets.get(identity);
		if (existing) {
			existing.scopes.add(entry.scope);
			continue;
		}

		targets.set(identity, {
			sourceSpec,
			cwd: entry.cwd,
			source,
			scopes: new Set([entry.scope]),
		});
	}

	return {
		localCount,
		targets: Array.from(targets.values()),
	};
}

export async function refreshConfiguredRemotePackages(
	workspaceDir: string,
): Promise<ConfiguredPackageRefreshReport> {
	const { localCount, targets } = collectRemoteRefreshTargets(workspaceDir);
	const refreshed: RefreshedConfiguredPackage[] = [];

	for (const target of targets) {
		const sourceLabel = formatPackageSource(target.source);
		try {
			refreshPackageSourceSync(target.source);
			const inspection = await inspectPackageSource(
				target.sourceSpec,
				target.cwd,
			);
			refreshed.push({
				source: sourceLabel,
				sourceType: target.source.type,
				scopes: Array.from(target.scopes).sort(compareScope),
				inspection,
				issues: collectPackageValidationIssues(inspection),
				error: null,
			});
		} catch (error) {
			refreshed.push({
				source: sourceLabel,
				sourceType: target.source.type,
				scopes: Array.from(target.scopes).sort(compareScope),
				inspection: null,
				issues: [],
				error:
					error instanceof Error
						? error.message
						: "Failed to refresh configured package.",
			});
		}
	}

	return {
		refreshed,
		localCount,
		remoteCount: targets.length,
	};
}

export function pruneUnconfiguredRemotePackageCaches(
	workspaceDir: string,
): PackageCachePruneReport {
	const { targets } = collectRemoteRefreshTargets(workspaceDir);
	const referencedPaths = new Set(
		targets.map((target) => getCachedRemotePackageSourcePath(target.source)),
	);
	const cachedPaths = listCachedRemotePackageSourcePaths();
	const removed: string[] = [];

	for (const cachedPath of cachedPaths) {
		if (referencedPaths.has(cachedPath)) {
			continue;
		}
		if (clearCachedPackageSourcePath(cachedPath)) {
			removed.push(cachedPath);
		}
	}

	return {
		cacheDir: getPackageCacheDir(),
		removed,
		removedCount: removed.length,
		referencedCount: referencedPaths.size,
	};
}
