/**
 * Package Loader
 *
 * Loads maestro packages from various sources and extracts resources.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { createLogger } from "../utils/logger.js";
import { discoverPackage } from "./discovery.js";
import { filterResources } from "./filters.js";
import {
	formatPackageSource,
	parsePackageSource,
	resolvePackageSource,
} from "./sources.js";
import type {
	LoadedPackage,
	PackageLoaderOptions,
	PackageResources,
	PackageSpec,
	ResourceFilters,
} from "./types.js";

const logger = createLogger("packages:loader");

/**
 * Parse a package specification into source and filters
 *
 * @param spec - Package specification (string or object)
 * @param cwd - Working directory
 * @returns Tuple of [source string, filters]
 */
export function parsePackageSpec(
	spec: PackageSpec,
	cwd?: string,
): [string, ResourceFilters | undefined] {
	if (typeof spec === "string") {
		return [spec, undefined];
	}

	// Object form with filters
	const { source, extensions, skills, prompts, themes } = spec;

	const filters: ResourceFilters = {};
	if (extensions) filters.extensions = extensions;
	if (skills) filters.skills = skills;
	if (prompts) filters.prompts = prompts;
	if (themes) filters.themes = themes;

	return [source, Object.keys(filters).length > 0 ? filters : undefined];
}

/**
 * Load a package from a specification
 *
 * @param spec - Package specification
 * @param options - Loader options
 * @returns Loaded package metadata
 */
export async function loadPackage(
	spec: PackageSpec,
	options?: PackageLoaderOptions,
): Promise<LoadedPackage> {
	const cwd = options?.cwd ?? process.cwd();
	const [sourceSpec, filters] = parsePackageSpec(spec, cwd);

	// Parse and resolve source
	const source = parsePackageSource(sourceSpec, cwd);
	const packagePath = await resolvePackageSource(source, options?.cacheDir);

	// Discover package
	const discovered = discoverPackage(packagePath);
	if (!discovered) {
		throw new Error(`No valid package found at: ${packagePath}`);
	}

	if (!discovered.isMaestroPackage) {
		throw new Error(
			`Package ${discovered.packageJson.name} is missing 'maestro-package' keyword`,
		);
	}

	if (discovered.errors && discovered.errors.length > 0) {
		throw new Error(
			`Package ${discovered.packageJson.name} has validation errors: ${discovered.errors.join(", ")}`,
		);
	}

	if (!discovered.packageJson.maestro) {
		throw new Error(
			`Package ${discovered.packageJson.name} is missing 'maestro' section in package.json`,
		);
	}

	logger.info("Loaded package", {
		name: discovered.packageJson.name,
		version: discovered.packageJson.version,
		source: formatPackageSource(source),
	});

	return {
		name: discovered.packageJson.name,
		version: discovered.packageJson.version,
		source,
		path: packagePath,
		manifest: discovered.packageJson.maestro,
		filters,
	};
}

/**
 * Load resources from a package
 *
 * @param pkg - Loaded package metadata
 * @returns Package resources with filtered paths
 */
export function loadPackageResources(pkg: LoadedPackage): PackageResources {
	const resources: PackageResources = {
		package: pkg,
		extensions: [],
		skills: [],
		prompts: [],
		themes: [],
	};

	// Load each resource type
	if (pkg.manifest.extensions) {
		resources.extensions = loadResourcePaths(
			pkg.path,
			pkg.manifest.extensions,
			pkg.filters?.extensions,
		);
	}

	if (pkg.manifest.skills) {
		resources.skills = loadResourcePaths(
			pkg.path,
			pkg.manifest.skills,
			pkg.filters?.skills,
		);
	}

	if (pkg.manifest.prompts) {
		resources.prompts = loadResourcePaths(
			pkg.path,
			pkg.manifest.prompts,
			pkg.filters?.prompts,
		);
	}

	if (pkg.manifest.themes) {
		resources.themes = loadResourcePaths(
			pkg.path,
			pkg.manifest.themes,
			pkg.filters?.themes,
		);
	}

	logger.debug("Loaded package resources", {
		package: pkg.name,
		extensions: resources.extensions.length,
		skills: resources.skills.length,
		prompts: resources.prompts.length,
		themes: resources.themes.length,
	});

	return resources;
}

/**
 * Load resource paths from manifest directories
 *
 * @param packagePath - Package root directory
 * @param manifestPaths - Paths from manifest (e.g., ["./extensions"])
 * @param filters - Glob patterns to filter resources
 * @returns Absolute paths to resources
 */
function loadResourcePaths(
	packagePath: string,
	manifestPaths: string[],
	filters?: string[],
): string[] {
	const allPaths: string[] = [];

	for (const manifestPath of manifestPaths) {
		const absolutePath = join(packagePath, manifestPath);

		if (!existsSync(absolutePath)) {
			logger.warn("Resource path does not exist", {
				path: absolutePath,
			});
			continue;
		}

		const stat = statSync(absolutePath);
		if (!stat.isDirectory()) {
			logger.warn("Resource path is not a directory", {
				path: absolutePath,
			});
			continue;
		}

		// List all items in the directory
		const items = readdirSync(absolutePath);

		for (const item of items) {
			const itemPath = join(absolutePath, item);
			const itemStat = statSync(itemPath);

			// Only include directories (each resource is a directory)
			if (itemStat.isDirectory()) {
				allPaths.push(itemPath);
			}
		}
	}

	// Apply filters
	if (filters && filters.length > 0) {
		// Get base names for filtering
		const baseNames = allPaths.map((p) => basename(p));
		const filteredNames = filterResources(baseNames, filters);

		// Map back to full paths
		return allPaths.filter((p) => filteredNames.includes(basename(p)));
	}

	return allPaths;
}

/**
 * Load multiple packages
 *
 * @param specs - Package specifications
 * @param options - Loader options
 * @returns Loaded package resources
 */
export async function loadPackages(
	specs: PackageSpec[],
	options?: PackageLoaderOptions,
): Promise<PackageResources[]> {
	const results: PackageResources[] = [];

	for (const spec of specs) {
		try {
			const pkg = await loadPackage(spec, options);
			const resources = loadPackageResources(pkg);
			results.push(resources);
		} catch (error) {
			logger.error("Failed to load package", undefined, {
				spec,
				error,
			});
			// Continue with other packages
		}
	}

	return results;
}

/**
 * Deduplicate packages by name (project scope overrides global scope)
 *
 * @param globalSpecs - Global package specs
 * @param projectSpecs - Project package specs
 * @returns Deduplicated package specs
 */
export function deduplicatePackages(
	globalSpecs: PackageSpec[],
	projectSpecs: PackageSpec[],
): PackageSpec[] {
	// Track package names from project scope
	const projectNames = new Set<string>();

	for (const spec of projectSpecs) {
		// Extract package name from source
		// This is a simplified version - real implementation would need
		// to handle all source types properly
		if (typeof spec === "string") {
			projectNames.add(spec);
		} else {
			projectNames.add(spec.source);
		}
	}

	// Filter global specs to exclude those overridden by project
	const deduplicated = [...projectSpecs];

	for (const spec of globalSpecs) {
		const specKey = typeof spec === "string" ? spec : spec.source;

		if (!projectNames.has(specKey)) {
			deduplicated.push(spec);
		}
	}

	return deduplicated;
}
