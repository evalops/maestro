import { dirname, resolve } from "node:path";
import type {
	MaestroAppServerPluginBundleListResult,
	MaestroAppServerPluginBundleMutationResult,
	MaestroAppServerPluginBundleScope,
} from "@evalops/contracts";
import {
	type WritablePackageScope,
	addConfiguredPackageSpecToConfig,
	getWritablePackageConfigPath,
	loadConfiguredPackageSpecs,
	removeConfiguredPackageSpecFromConfig,
} from "../config/toml-config.js";
import { parsePackageSpec } from "../packages/loader.js";
import { loadConfiguredPackageResources } from "../packages/runtime.js";
import {
	formatPackageSource,
	parsePackageSource,
} from "../packages/sources.js";
import type { PackageSpec } from "../packages/types.js";

type UnknownRecord = Record<string, unknown>;

export class MaestroAppServerPluginBundleError extends Error {
	constructor(
		readonly code: number,
		message: string,
	) {
		super(message);
		this.name = "MaestroAppServerPluginBundleError";
	}
}

export interface MaestroAppServerPluginBundleApi {
	listBundles(
		params?: UnknownRecord,
	): Promise<MaestroAppServerPluginBundleListResult>;
	installBundle(
		params?: UnknownRecord,
	): Promise<MaestroAppServerPluginBundleMutationResult>;
	removeBundle(
		params?: UnknownRecord,
	): Promise<MaestroAppServerPluginBundleMutationResult>;
}

export interface MaestroAppServerPluginBundleApiOptions {
	projectRoot?: string;
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function paramsRecord(params: unknown): UnknownRecord {
	if (params === undefined) {
		return {};
	}
	if (isRecord(params)) {
		return params;
	}
	throw new MaestroAppServerPluginBundleError(-32602, "Invalid params");
}

function projectRootFromParams(
	params: UnknownRecord,
	options: MaestroAppServerPluginBundleApiOptions,
): string {
	return resolve(
		stringValue(params.projectRoot) ?? options.projectRoot ?? process.cwd(),
	);
}

function scopeFromParams(params: UnknownRecord): WritablePackageScope {
	const scope = stringValue(params.scope);
	if (scope === "project" || scope === "local" || scope === "user") {
		return scope;
	}
	if (scope !== undefined) {
		throw new MaestroAppServerPluginBundleError(
			-32602,
			"Invalid plugin bundle scope",
		);
	}
	return "local";
}

function packageSpecFromParams(params: UnknownRecord): PackageSpec {
	const spec = params.spec ?? params.source;
	if (typeof spec === "string" && spec.trim()) {
		return spec.trim();
	}
	if (isRecord(spec) && typeof spec.source === "string" && spec.source.trim()) {
		return spec as unknown as PackageSpec;
	}
	throw new MaestroAppServerPluginBundleError(
		-32602,
		"Plugin bundle requires source or spec",
	);
}

function sourceString(spec: PackageSpec): string {
	return typeof spec === "string" ? spec : spec.source;
}

function resolvePackageSpecIdentity(spec: PackageSpec, cwd: string): string {
	const [sourceSpec] = parsePackageSpec(spec, cwd);
	return formatPackageSource(parsePackageSource(sourceSpec, cwd));
}

function tryResolvePackageSourceIdentity(
	sourceSpec: string,
	cwd: string,
): string | null {
	try {
		return formatPackageSource(parsePackageSource(sourceSpec, cwd));
	} catch {
		return null;
	}
}

function configuredPackageMatches(
	entry: ReturnType<typeof loadConfiguredPackageSpecs>[number],
	requestedSpec: string,
	requestedCwd: string,
): boolean {
	const [rawSourceSpec] = parsePackageSpec(entry.spec, entry.cwd);
	if (rawSourceSpec === requestedSpec) {
		return true;
	}
	const requestedIdentity = tryResolvePackageSourceIdentity(
		requestedSpec,
		requestedCwd,
	);
	if (!requestedIdentity) {
		return false;
	}
	return (
		resolvePackageSpecIdentity(entry.spec, entry.cwd) === requestedIdentity
	);
}

function validateBundleInstall(
	projectRoot: string,
	scope: WritablePackageScope,
	spec: PackageSpec,
): { configPath: string } {
	const configPath = getWritablePackageConfigPath(scope, projectRoot);
	const configDir = dirname(configPath);
	const requestedIdentity = resolvePackageSpecIdentity(spec, projectRoot);
	const duplicate = loadConfiguredPackageSpecs(projectRoot).find(
		(entry) =>
			entry.configPath === configPath &&
			resolvePackageSpecIdentity(entry.spec, configDir) === requestedIdentity,
	);
	if (duplicate) {
		const [sourceSpec] = parsePackageSpec(duplicate.spec, configDir);
		throw new MaestroAppServerPluginBundleError(
			-32602,
			`Package "${sourceSpec}" already exists in ${configPath}.`,
		);
	}
	return { configPath };
}

function resolveBundleRemoval(
	projectRoot: string,
	spec: PackageSpec,
	scope?: WritablePackageScope,
): { configPath: string; scope: WritablePackageScope } {
	const requestedSpec = sourceString(spec);
	const matches = loadConfiguredPackageSpecs(projectRoot).filter(
		(entry) =>
			(scope === undefined || entry.scope === scope) &&
			configuredPackageMatches(entry, requestedSpec, projectRoot),
	);
	const orderedScopes: WritablePackageScope[] =
		scope === undefined ? ["local", "project", "user"] : [scope];
	for (const candidateScope of orderedScopes) {
		const match = matches.find((entry) => entry.scope === candidateScope);
		if (match) {
			return { configPath: match.configPath, scope: match.scope };
		}
	}
	const scopeMessage = scope === undefined ? "" : ` in ${scope} config`;
	throw new MaestroAppServerPluginBundleError(
		-32602,
		`Configured package "${requestedSpec}" was not found${scopeMessage}.`,
	);
}

function toBundleScope(
	scope: WritablePackageScope,
): MaestroAppServerPluginBundleScope {
	return scope;
}

function pluginBundleErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function toPluginBundleInvalidParams(
	error: unknown,
): MaestroAppServerPluginBundleError {
	if (error instanceof MaestroAppServerPluginBundleError) {
		return error;
	}
	return new MaestroAppServerPluginBundleError(
		-32602,
		pluginBundleErrorMessage(error),
	);
}

export function createMaestroAppServerPluginBundleApi(
	options: MaestroAppServerPluginBundleApiOptions = {},
): MaestroAppServerPluginBundleApi {
	return {
		async listBundles(params = {}) {
			const normalizedParams = paramsRecord(params);
			const projectRoot = projectRootFromParams(normalizedParams, options);
			const resources = loadConfiguredPackageResources(projectRoot);
			return {
				bundles: loadConfiguredPackageSpecs(projectRoot).map((entry) => ({
					source: sourceString(entry.spec),
					scope: toBundleScope(entry.scope),
					configPath: entry.configPath,
				})),
				resources: {
					extensions: resources.extensions,
					skills: resources.skills,
					prompts: resources.prompts,
					themes: resources.themes,
				},
				errors: resources.errors,
			};
		},

		async installBundle(params = {}) {
			const normalizedParams = paramsRecord(params);
			const projectRoot = projectRootFromParams(normalizedParams, options);
			const spec = packageSpecFromParams(normalizedParams);
			const source = sourceString(spec);
			const scope = scopeFromParams(normalizedParams);
			let validation: ReturnType<typeof validateBundleInstall>;
			try {
				validation = validateBundleInstall(projectRoot, scope, spec);
			} catch (error) {
				throw toPluginBundleInvalidParams(error);
			}
			const { configPath } = validation;
			if (booleanValue(normalizedParams.dryRun, false)) {
				return {
					source,
					scope,
					configPath,
					changed: false,
					message: "Plugin bundle install planned",
				};
			}
			let result: ReturnType<typeof addConfiguredPackageSpecToConfig>;
			try {
				result = addConfiguredPackageSpecToConfig({
					workspaceDir: projectRoot,
					scope,
					spec,
				});
			} catch (error) {
				throw toPluginBundleInvalidParams(error);
			}
			return {
				source,
				scope: result.scope,
				configPath: result.path,
				changed: true,
				message: "Plugin bundle installed",
			};
		},

		async removeBundle(params = {}) {
			const normalizedParams = paramsRecord(params);
			const projectRoot = projectRootFromParams(normalizedParams, options);
			const spec = packageSpecFromParams(normalizedParams);
			const scope =
				normalizedParams.scope === undefined
					? undefined
					: scopeFromParams(normalizedParams);
			const removal = resolveBundleRemoval(projectRoot, spec, scope);
			if (booleanValue(normalizedParams.dryRun, false)) {
				return {
					source: sourceString(spec),
					scope: removal.scope,
					configPath: removal.configPath,
					changed: false,
					message: "Plugin bundle removal planned",
				};
			}
			let result: ReturnType<typeof removeConfiguredPackageSpecFromConfig>;
			try {
				result = removeConfiguredPackageSpecFromConfig({
					workspaceDir: projectRoot,
					scope,
					spec: sourceString(spec),
				});
			} catch (error) {
				throw new MaestroAppServerPluginBundleError(
					-32602,
					pluginBundleErrorMessage(error),
				);
			}
			return {
				source: sourceString(spec),
				scope: result.scope,
				configPath: result.path,
				changed: result.removedCount > 0,
				message: `Removed ${result.removedCount} plugin bundle(s)`,
			};
		},
	};
}
