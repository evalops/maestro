/**
 * Maestro Package System
 *
 * Distributable extension bundles that can be loaded from local filesystem,
 * git repositories, or npm packages.
 *
 * @example
 * ```typescript
 * import { loadPackages } from "./packages";
 *
 * // Load packages from config
 * const resources = await loadPackages([
 *   "./packages/my-pack",  // Local package
 *   "git:github.com/user/pack@v1",  // Git repository
 *   { source: "npm:@org/pack", skills: ["*"], extensions: ["!deprecated"] }
 * ]);
 *
 * // Access loaded resources
 * for (const pkg of resources) {
 *   console.log(`${pkg.package.name}: ${pkg.skills.length} skills`);
 * }
 * ```
 */

export { discoverPackage, isValidMaestroPackage } from "./discovery.js";
export { filterResources, matchesAnyPattern } from "./filters.js";
export {
	deduplicatePackages,
	loadPackage,
	loadPackageResources,
	loadPackages,
	parsePackageSpec,
} from "./loader.js";
export {
	loadConfiguredPackageResources,
	type ConfiguredPackageRuntimeResources,
	type ScopedPackageResourceDirectories,
} from "./runtime.js";
export {
	clearResolvedPackageSourceCache,
	clearCachedPackageSourcePath,
	clearCachedPackageSource,
	formatPackageSource,
	getCachedRemotePackageSourcePath,
	getPackageCacheDir,
	listCachedRemotePackageSourcePaths,
	parsePackageSource,
	refreshPackageSourceSync,
	resolvePackageSource,
	resolvePackageSourceSync,
} from "./sources.js";
export {
	refreshConfiguredRemotePackages,
	type ConfiguredPackageRefreshReport,
	type RefreshedConfiguredPackage,
} from "./maintenance.js";
export type {
	DiscoveredPackage,
	GitSource,
	LoadedPackage,
	LocalSource,
	MaestroManifest,
	NpmSource,
	PackageJson,
	PackageLoaderOptions,
	PackageResources,
	PackageSource,
	PackageSourceType,
	PackageSpec,
	ResourceFilters,
} from "./types.js";
