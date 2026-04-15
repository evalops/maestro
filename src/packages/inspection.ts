import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	type ConfiguredPackageSpec,
	loadConfiguredPackageSpecs,
} from "../config/toml-config.js";
import { discoverPackage } from "./discovery.js";
import {
	loadPackage,
	loadPackageResources,
	parsePackageSpec,
} from "./loader.js";
import { parsePackageSource, resolvePackageSource } from "./sources.js";
import type {
	DiscoveredPackage,
	MaestroManifest,
	PackageResources,
	PackageSource,
	ResourceFilters,
} from "./types.js";

export interface InspectedPackage {
	sourceSpec: string;
	source: PackageSource;
	resolvedPath: string;
	discovered: DiscoveredPackage | null;
	resources?: PackageResources;
}

export interface ConfiguredPackageReport {
	entry: ConfiguredPackageSpec;
	sourceSpec: string;
	filters?: ResourceFilters;
	inspected?: InspectedPackage;
	error?: string;
}

export async function inspectPackageSource(
	sourceSpec: string,
	cwd: string,
): Promise<InspectedPackage> {
	const source = parsePackageSource(sourceSpec, cwd);
	const resolvedPath = await resolvePackageSource(source);
	const discovered = discoverPackage(resolvedPath);
	const inspected: InspectedPackage = {
		sourceSpec,
		source,
		resolvedPath,
		discovered,
	};

	if (
		discovered?.isMaestroPackage &&
		(discovered.errors?.length ?? 0) === 0 &&
		discovered.packageJson.maestro
	) {
		const loadedPackage = await loadPackage(sourceSpec, { cwd });
		inspected.resources = loadPackageResources(loadedPackage);
	}

	return inspected;
}

export function collectPackageValidationIssues(
	inspected: InspectedPackage,
): string[] {
	if (!inspected.discovered) {
		return [`No valid package.json found at ${inspected.resolvedPath}.`];
	}

	const issues: string[] = [];
	if (!inspected.discovered.isMaestroPackage) {
		issues.push('Missing "maestro-package" keyword.');
	}

	for (const error of inspected.discovered.errors ?? []) {
		issues.push(error);
	}

	const manifest = inspected.discovered.packageJson.maestro;
	if (!manifest) {
		issues.push('Missing "maestro" section in package.json.');
		return issues;
	}

	issues.push(...collectManifestPathIssues(inspected.resolvedPath, manifest));
	return issues;
}

function collectManifestPathIssues(
	packagePath: string,
	manifest: MaestroManifest,
): string[] {
	const issues: string[] = [];
	for (const key of ["extensions", "skills", "prompts", "themes"] as const) {
		const manifestPaths = manifest[key];
		if (!Array.isArray(manifestPaths)) {
			continue;
		}

		for (const manifestPath of manifestPaths) {
			const absolutePath = join(packagePath, manifestPath);
			if (!existsSync(absolutePath)) {
				issues.push(`${key} path does not exist: ${manifestPath}`);
				continue;
			}

			if (!statSync(absolutePath).isDirectory()) {
				issues.push(`${key} path is not a directory: ${manifestPath}`);
			}
		}
	}
	return issues;
}

export async function listConfiguredPackageReports(
	workspaceDir: string,
): Promise<ConfiguredPackageReport[]> {
	const configured = loadConfiguredPackageSpecs(workspaceDir);
	const reports: ConfiguredPackageReport[] = [];
	for (const entry of configured) {
		const [sourceSpec, filters] = parsePackageSpec(entry.spec, entry.cwd);
		try {
			reports.push({
				entry,
				sourceSpec,
				filters,
				inspected: await inspectPackageSource(sourceSpec, entry.cwd),
			});
		} catch (error) {
			reports.push({
				entry,
				sourceSpec,
				filters,
				error:
					error instanceof Error
						? error.message
						: "Failed to inspect configured package.",
			});
		}
	}

	return reports;
}
