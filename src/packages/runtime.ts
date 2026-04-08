import { resolve } from "node:path";
import {
	type ConfiguredPackageSpec,
	loadConfiguredPackageSpecs,
} from "../config/toml-config.js";
import { createLogger } from "../utils/logger.js";
import { discoverPackage } from "./discovery.js";
import { loadPackageResources, parsePackageSpec } from "./loader.js";
import { parsePackageSource, resolvePackageSourceSync } from "./sources.js";
import type { LoadedPackage, PackageResources } from "./types.js";

const logger = createLogger("packages:runtime");

const RESOURCE_KINDS = ["extensions", "skills", "prompts", "themes"] as const;

type ResourceKind = (typeof RESOURCE_KINDS)[number];
type PackageScope = ConfiguredPackageSpec["scope"];
type RuntimePackageScope = Exclude<PackageScope, "local"> | "project";

export interface ScopedPackageResourceDirectories {
	user: string[];
	project: string[];
}

export interface ConfiguredPackageRuntimeResources {
	extensions: ScopedPackageResourceDirectories;
	skills: ScopedPackageResourceDirectories;
	prompts: ScopedPackageResourceDirectories;
	themes: ScopedPackageResourceDirectories;
	errors: string[];
}

const reportedRuntimePackageErrors = new Set<string>();

function createScopedDirectories(): ScopedPackageResourceDirectories {
	return { user: [], project: [] };
}

function createConfiguredPackageRuntimeResources(): ConfiguredPackageRuntimeResources {
	return {
		extensions: createScopedDirectories(),
		skills: createScopedDirectories(),
		prompts: createScopedDirectories(),
		themes: createScopedDirectories(),
		errors: [],
	};
}

function reportConfiguredPackageErrorOnce(
	entry: ConfiguredPackageSpec,
	error: Error,
): void {
	const source =
		typeof entry.spec === "string" ? entry.spec : entry.spec.source;
	const message = `[${entry.scope}] ${entry.configPath} :: ${source} :: ${error.message}`;
	if (reportedRuntimePackageErrors.has(message)) {
		return;
	}
	reportedRuntimePackageErrors.add(message);
	logger.warn("Failed to load configured runtime package", {
		scope: entry.scope,
		configPath: entry.configPath,
		source,
		error: error.message,
	});
}

function loadConfiguredPackageResourcesEntry(
	entry: ConfiguredPackageSpec,
): PackageResources {
	const [sourceSpec, filters] = parsePackageSpec(entry.spec, entry.cwd);
	const source = parsePackageSource(sourceSpec, entry.cwd);
	const packagePath = resolvePackageSourceSync(source);

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
		throw new Error(discovered.errors.join(", "));
	}

	if (!discovered.packageJson.maestro) {
		throw new Error(
			`Package ${discovered.packageJson.name} is missing 'maestro' section in package.json`,
		);
	}

	const loadedPackage: LoadedPackage = {
		name: discovered.packageJson.name,
		version: discovered.packageJson.version,
		source,
		path: packagePath,
		manifest: discovered.packageJson.maestro,
		filters,
	};

	return loadPackageResources(loadedPackage);
}

function addScopedDirectories(
	target: string[],
	seen: Set<string>,
	directories: string[],
): void {
	for (const directory of directories) {
		const normalized = resolve(directory);
		if (seen.has(normalized)) {
			continue;
		}
		seen.add(normalized);
		target.push(normalized);
	}
}

function getRuntimePackageScope(scope: PackageScope): RuntimePackageScope {
	return scope === "user" ? "user" : "project";
}

export function loadConfiguredPackageResources(
	workspaceDir: string,
): ConfiguredPackageRuntimeResources {
	const resources = createConfiguredPackageRuntimeResources();
	const seen: Record<ResourceKind, Record<RuntimePackageScope, Set<string>>> = {
		extensions: { user: new Set(), project: new Set() },
		skills: { user: new Set(), project: new Set() },
		prompts: { user: new Set(), project: new Set() },
		themes: { user: new Set(), project: new Set() },
	};

	for (const entry of loadConfiguredPackageSpecs(workspaceDir)) {
		try {
			const packageResources = loadConfiguredPackageResourcesEntry(entry);
			const runtimeScope = getRuntimePackageScope(entry.scope);
			for (const kind of RESOURCE_KINDS) {
				addScopedDirectories(
					resources[kind][runtimeScope],
					seen[kind][runtimeScope],
					packageResources[kind],
				);
			}
		} catch (error) {
			const resolvedError =
				error instanceof Error ? error : new Error(String(error));
			reportConfiguredPackageErrorOnce(entry, resolvedError);
			resources.errors.push(`${entry.configPath}: ${resolvedError.message}`);
		}
	}

	return resources;
}
