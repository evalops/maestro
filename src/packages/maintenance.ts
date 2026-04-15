import { resolve } from "node:path";
import {
	type ConfiguredPackageSpec,
	type WritablePackageScope,
	loadConfiguredPackageSpecs,
} from "../config/toml-config.js";
import { createLogger } from "../utils/logger.js";
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

const logger = createLogger("packages:maintenance");

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

export interface ConfiguredRemotePackageAutoSyncReport {
	workspaceDir: string;
	refresh: ConfiguredPackageRefreshReport;
	prune: PackageCachePruneReport;
	failureCount: number;
}

const configuredRemotePackageAutoSyncs = new Map<
	string,
	Promise<ConfiguredRemotePackageAutoSyncReport | null>
>();

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

function normalizeWorkspaceDir(workspaceDir: string): string {
	return resolve(workspaceDir.trim().length > 0 ? workspaceDir : process.cwd());
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

export function clearConfiguredRemotePackageAutoSyncState(
	workspaceDir?: string,
): void {
	if (workspaceDir) {
		configuredRemotePackageAutoSyncs.delete(
			normalizeWorkspaceDir(workspaceDir),
		);
		return;
	}
	configuredRemotePackageAutoSyncs.clear();
}

export function scheduleConfiguredRemotePackageAutoSync(
	workspaceDir: string,
): Promise<ConfiguredRemotePackageAutoSyncReport | null> | null {
	if (process.env.MAESTRO_DISABLE_PACKAGE_AUTO_SYNC === "1") {
		return null;
	}

	const normalizedWorkspaceDir = normalizeWorkspaceDir(workspaceDir);
	const existing = configuredRemotePackageAutoSyncs.get(normalizedWorkspaceDir);
	if (existing) {
		return existing;
	}

	const syncPromise =
		(async (): Promise<ConfiguredRemotePackageAutoSyncReport | null> => {
			try {
				const refresh = await refreshConfiguredRemotePackages(
					normalizedWorkspaceDir,
				);
				if (refresh.remoteCount === 0) {
					return null;
				}

				const prune = pruneUnconfiguredRemotePackageCaches(
					normalizedWorkspaceDir,
				);
				const failureCount = refresh.refreshed.filter(
					(entry) => entry.error !== null,
				).length;
				const report: ConfiguredRemotePackageAutoSyncReport = {
					workspaceDir: normalizedWorkspaceDir,
					refresh,
					prune,
					failureCount,
				};

				if (failureCount > 0) {
					logger.warn(
						"Configured remote package auto-sync completed with failures",
						{
							workspaceDir: normalizedWorkspaceDir,
							remoteCount: refresh.remoteCount,
							failureCount,
							removedCacheCount: prune.removedCount,
						},
					);
				} else {
					logger.info("Configured remote package auto-sync completed", {
						workspaceDir: normalizedWorkspaceDir,
						remoteCount: refresh.remoteCount,
						removedCacheCount: prune.removedCount,
					});
				}

				return report;
			} catch (error) {
				logger.warn("Configured remote package auto-sync failed", {
					workspaceDir: normalizedWorkspaceDir,
					error: error instanceof Error ? error.message : String(error),
				});
				return null;
			}
		})();

	configuredRemotePackageAutoSyncs.set(normalizedWorkspaceDir, syncPromise);
	return syncPromise;
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
