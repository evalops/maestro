import { resolve } from "node:path";
import {
	type ComposerConfig,
	type ConfiguredPackageSpec,
	type WritablePackageScope,
	loadConfiguredPackageSpecs,
	resolveRuntimeConfigResolutionOptions,
} from "../config/toml-config.js";
import { createLogger } from "../utils/logger.js";
import { sanitizeWithStaticMask } from "../utils/secret-redactor.js";
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

/**
 * Trust context for resolving which configured package specs participate in a
 * remote refresh/prune. This must mirror the context used to actually load the
 * packages so that remote sources from untrusted project/local config are not
 * fetched or cached when the corresponding load would skip them.
 */
export interface ConfiguredRemotePackageTrustOptions {
	profileName?: string;
	cliOverrides?: Partial<ComposerConfig>;
}

const configuredRemotePackageAutoSyncs = new Map<
	string,
	Promise<ConfiguredRemotePackageAutoSyncReport | null>
>();

function stableTrustOptionsString(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableTrustOptionsString(item)).join(",")}]`;
	}
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, item]) => typeof item !== "undefined")
			.sort(([left], [right]) => left.localeCompare(right))
			.map(
				([key, item]) =>
					`${JSON.stringify(key)}:${stableTrustOptionsString(item)}`,
			)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

function getConfiguredRemotePackageAutoSyncKey(
	workspaceDir: string,
	options: ConfiguredRemotePackageTrustOptions,
): string {
	return `${normalizeWorkspaceDir(workspaceDir)}\u0000${stableTrustOptionsString(
		{
			profileName: options.profileName,
			cliOverrides: options.cliOverrides,
		},
	)}`;
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

function normalizeWorkspaceDir(workspaceDir: string): string {
	return resolve(workspaceDir.trim().length > 0 ? workspaceDir : process.cwd());
}

function collectRemoteRefreshTargets(
	workspaceDir: string,
	options: ConfiguredRemotePackageTrustOptions = {},
): {
	localCount: number;
	targets: RemoteRefreshTarget[];
} {
	const resolvedOptions = resolveRuntimeConfigResolutionOptions(
		workspaceDir,
		options,
	);
	const targets = new Map<string, RemoteRefreshTarget>();
	let localCount = 0;

	for (const entry of loadConfiguredPackageSpecs(
		workspaceDir,
		resolvedOptions.profileName,
		resolvedOptions.cliOverrides,
	)) {
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
	options: ConfiguredRemotePackageTrustOptions = {},
): Promise<ConfiguredPackageRefreshReport> {
	const { localCount, targets } = collectRemoteRefreshTargets(
		workspaceDir,
		options,
	);
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
		const normalizedWorkspaceDir = normalizeWorkspaceDir(workspaceDir);
		const workspaceKeyPrefix = `${normalizedWorkspaceDir}\u0000`;
		for (const key of configuredRemotePackageAutoSyncs.keys()) {
			if (key.startsWith(workspaceKeyPrefix)) {
				configuredRemotePackageAutoSyncs.delete(key);
			}
		}
		return;
	}
	configuredRemotePackageAutoSyncs.clear();
}

export function scheduleConfiguredRemotePackageAutoSync(
	workspaceDir: string,
	options: ConfiguredRemotePackageTrustOptions = {},
): Promise<ConfiguredRemotePackageAutoSyncReport | null> | null {
	if (process.env.MAESTRO_DISABLE_PACKAGE_AUTO_SYNC === "1") {
		return null;
	}

	const normalizedWorkspaceDir = normalizeWorkspaceDir(workspaceDir);
	const autoSyncKey = getConfiguredRemotePackageAutoSyncKey(
		normalizedWorkspaceDir,
		options,
	);
	const existing = configuredRemotePackageAutoSyncs.get(autoSyncKey);
	if (existing) {
		return existing;
	}

	const syncPromise =
		(async (): Promise<ConfiguredRemotePackageAutoSyncReport | null> => {
			try {
				const refresh = await refreshConfiguredRemotePackages(
					normalizedWorkspaceDir,
					options,
				);
				if (refresh.remoteCount === 0) {
					return null;
				}

				const prune = pruneUnconfiguredRemotePackageCaches(
					normalizedWorkspaceDir,
					options,
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
					error: sanitizeWithStaticMask(
						error instanceof Error ? error.message : String(error),
					),
				});
				return null;
			}
		})();

	configuredRemotePackageAutoSyncs.set(autoSyncKey, syncPromise);
	return syncPromise;
}

export function pruneUnconfiguredRemotePackageCaches(
	workspaceDir: string,
	options: ConfiguredRemotePackageTrustOptions = {},
): PackageCachePruneReport {
	const { targets } = collectRemoteRefreshTargets(workspaceDir, options);
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
