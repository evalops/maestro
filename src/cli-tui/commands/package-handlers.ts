import { basename, relative } from "node:path";
import {
	type ConfiguredPackageSpec,
	type WritablePackageScope,
	addConfiguredPackageSpecToConfig,
	loadConfiguredPackageSpecs,
	removeConfiguredPackageSpecFromConfig,
} from "../../config/index.js";
import {
	type ResourceFilters,
	formatPackageSource,
	parsePackageSource,
	parsePackageSpec,
} from "../../packages/index.js";
import {
	type ConfiguredPackageReport,
	type InspectedPackage,
	collectPackageValidationIssues,
	inspectPackageSource,
	listConfiguredPackageReports,
} from "../../packages/inspection.js";
import {
	type ConfiguredPackageRefreshReport,
	refreshConfiguredRemotePackages,
} from "../../packages/maintenance.js";
import { refreshPackageSourceSync } from "../../packages/sources.js";
import { parseCommandArguments } from "../../tools/shell-utils.js";
import type { CommandExecutionContext } from "./types.js";

const PACKAGE_INSPECT_USAGE = "/package [inspect|validate] <source>";
const PACKAGE_REFRESH_USAGE = "/package refresh [<source>|--all]";
const PACKAGE_ADD_USAGE = "/package add <source> [--scope local|project|user]";
const PACKAGE_REMOVE_USAGE =
	"/package remove <source> [--scope local|project|user]";

export interface PackageCommandDeps {
	cwd: string;
	addContent(content: string): void;
	requestRender(): void;
}

export const PACKAGE_SUBCOMMANDS = [
	{ name: "add", description: "Add a Maestro package to config.toml" },
	{ name: "list", description: "List configured Maestro packages" },
	{ name: "remove", description: "Remove a Maestro package from config.toml" },
	{ name: "refresh", description: "Refresh a configured remote package cache" },
	{ name: "inspect", description: "Inspect a Maestro package source" },
	{ name: "validate", description: "Validate a Maestro package source" },
] as const;

export function createPackageCommandHandler(deps: PackageCommandDeps) {
	return async function handlePackageCommand(
		ctx: CommandExecutionContext,
	): Promise<void> {
		let tokens: string[];
		try {
			tokens = parsePackageCommandTokens(ctx.rawInput);
		} catch (error) {
			ctx.showError(
				error instanceof Error
					? error.message
					: "Failed to parse /package args.",
			);
			return;
		}

		if (tokens.length === 0) {
			showPackageHelp(deps);
			return;
		}

		const subcommand = tokens[0]!.toLowerCase();
		if (isHelpSubcommand(subcommand)) {
			showPackageHelp(deps);
			return;
		}

		if (subcommand === "list") {
			if (tokens.length !== 1) {
				ctx.showError("Usage: /package list");
				showPackageHelp(deps);
				return;
			}
			await runPackageList(deps);
			return;
		}

		if (subcommand === "add") {
			try {
				const parsed = parsePackageMutationTokens(tokens, "add");
				runPackageAdd(parsed, deps);
			} catch (error) {
				ctx.showError(
					error instanceof Error
						? error.message
						: "Failed to parse /package add args.",
				);
				showPackageHelp(deps);
			}
			return;
		}

		if (subcommand === "remove") {
			try {
				const parsed = parsePackageMutationTokens(tokens, "remove");
				runPackageRemove(parsed, deps);
			} catch (error) {
				ctx.showError(
					error instanceof Error
						? error.message
						: "Failed to parse /package remove args.",
				);
				showPackageHelp(deps);
			}
			return;
		}

		if (subcommand === "refresh") {
			if (tokens.length === 1 || isRefreshAllToken(tokens[1])) {
				await runPackageRefreshAll(deps, ctx);
				return;
			}
			if (tokens.length === 2) {
				await runPackageRefresh(tokens[1]!, deps, ctx);
				return;
			}
			ctx.showError(`Usage: ${PACKAGE_REFRESH_USAGE}`);
			showPackageHelp(deps);
			return;
		}

		if (subcommand === "inspect" || subcommand === "validate") {
			if (tokens.length !== 2) {
				ctx.showError(`Usage: ${PACKAGE_INSPECT_USAGE}`);
				showPackageHelp(deps);
				return;
			}
			await runPackageSubcommand(subcommand, tokens[1]!, deps, ctx);
			return;
		}

		if (tokens.length === 1) {
			await runPackageSubcommand("inspect", tokens[0]!, deps, ctx);
			return;
		}

		ctx.showError(`Unknown subcommand: ${tokens[0]}`);
		showPackageHelp(deps);
	};
}

function isHelpSubcommand(value: string): boolean {
	return (
		value === "help" || value === "?" || value === "--help" || value === "-h"
	);
}

function isRefreshAllToken(value: string | undefined): boolean {
	return value === "--all" || value === "all";
}

function parsePackageCommandTokens(rawInput: string): string[] {
	const remainder = rawInput.replace(/^\/(?:package|plugin)\b/i, "").trim();
	if (!remainder) {
		return [];
	}
	return parseCommandArguments(remainder);
}

function isWritablePackageScope(value: string): value is WritablePackageScope {
	return value === "local" || value === "project" || value === "user";
}

function parsePackageMutationTokens(
	tokens: string[],
	mode: "add" | "remove",
): { sourceSpec: string; scope?: WritablePackageScope } {
	const args = tokens.slice(1);
	let sourceSpec: string | undefined;
	let scope: WritablePackageScope | undefined;

	for (let index = 0; index < args.length; index += 1) {
		const token = args[index]!;
		if (token === "--scope" || token === "-s") {
			const next = args[index + 1];
			if (!next || !isWritablePackageScope(next)) {
				throw new Error("Invalid package scope. Use local, project, or user.");
			}
			scope = next;
			index += 1;
			continue;
		}

		if (token.startsWith("-")) {
			throw new Error(`Unknown option: ${token}`);
		}

		if (sourceSpec) {
			throw new Error(
				`Usage: ${mode === "add" ? PACKAGE_ADD_USAGE : PACKAGE_REMOVE_USAGE}`,
			);
		}
		sourceSpec = token;
	}

	if (!sourceSpec) {
		throw new Error(
			`Usage: ${mode === "add" ? PACKAGE_ADD_USAGE : PACKAGE_REMOVE_USAGE}`,
		);
	}

	return { sourceSpec, scope };
}

async function runPackageSubcommand(
	subcommand: "inspect" | "validate",
	sourceSpec: string,
	deps: PackageCommandDeps,
	ctx: CommandExecutionContext,
): Promise<void> {
	let inspected: InspectedPackage;
	try {
		inspected = await inspectPackageSource(sourceSpec, deps.cwd);
	} catch (error) {
		ctx.showError(
			error instanceof Error ? error.message : "Failed to inspect package.",
		);
		return;
	}

	if (subcommand === "inspect") {
		publishOutput(deps, formatInspectReport(inspected, deps.cwd));
		return;
	}

	const issues = collectPackageValidationIssues(inspected);
	if (issues.length > 0) {
		publishOutput(deps, formatValidationFailure(inspected, issues, deps.cwd));
		return;
	}

	publishOutput(deps, formatValidationSuccess(inspected, deps.cwd));
}

async function runPackageRefresh(
	sourceSpec: string,
	deps: PackageCommandDeps,
	ctx: CommandExecutionContext,
): Promise<void> {
	try {
		const source = parsePackageSource(sourceSpec, deps.cwd);
		refreshPackageSourceSync(source);
		const inspected = await inspectPackageSource(sourceSpec, deps.cwd);
		publishOutput(deps, formatRefreshSuccess(inspected));
	} catch (error) {
		ctx.showError(
			error instanceof Error ? error.message : "Failed to refresh package.",
		);
	}
}

async function runPackageRefreshAll(
	deps: PackageCommandDeps,
	ctx: CommandExecutionContext,
): Promise<void> {
	try {
		const refreshed = await refreshConfiguredRemotePackages(deps.cwd);
		publishOutput(deps, formatRefreshAllSuccess(refreshed));
	} catch (error) {
		ctx.showError(
			error instanceof Error
				? error.message
				: "Failed to refresh configured packages.",
		);
	}
}

function runPackageAdd(
	parsed: { sourceSpec: string; scope?: WritablePackageScope },
	deps: PackageCommandDeps,
): void {
	const { path, scope, spec } = addConfiguredPackageSpecToConfig({
		workspaceDir: deps.cwd,
		scope: parsed.scope ?? "local",
		spec: parsed.sourceSpec,
	});
	const storedSpec = typeof spec === "string" ? spec : spec.source;
	const lines = [
		`Added configured package "${parsed.sourceSpec}"`,
		`  scope: ${scope}`,
		`  path: ${path}`,
	];
	if (storedSpec !== parsed.sourceSpec) {
		lines.push(`  stored: ${storedSpec}`);
	}
	publishOutput(deps, lines.join("\n"));
}

function runPackageRemove(
	parsed: { sourceSpec: string; scope?: WritablePackageScope },
	deps: PackageCommandDeps,
): void {
	const { path, scope, removedCount } = removeConfiguredPackageSpecFromConfig({
		workspaceDir: deps.cwd,
		scope: parsed.scope,
		spec: parsed.sourceSpec,
	});
	const fallback = findConfiguredPackageFallback(parsed.sourceSpec, deps.cwd);
	const lines = [
		`Removed configured package "${parsed.sourceSpec}"`,
		`  scope: ${scope}`,
		`  path: ${path}`,
		`  removed: ${removedCount}`,
	];
	if (fallback) {
		lines.push(
			`  fallback: still configured in ${fallback.scope} (${fallback.sourceSpec})`,
		);
	} else {
		lines.push("  status: removed from merged config");
	}
	publishOutput(deps, lines.join("\n"));
}

async function runPackageList(deps: PackageCommandDeps): Promise<void> {
	if (loadConfiguredPackageSpecs(deps.cwd).length === 0) {
		publishOutput(
			deps,
			"No configured Maestro packages found in ~/.maestro/config.toml, .maestro/config.toml, or .maestro/config.local.toml.",
		);
		return;
	}

	const reports = await listConfiguredPackageReports(deps.cwd);
	publishOutput(deps, formatConfiguredPackageList(reports, deps.cwd));
}

function findConfiguredPackageFallback(
	sourceSpec: string,
	cwd: string,
): { scope: ConfiguredPackageSpec["scope"]; sourceSpec: string } | null {
	const requestedIdentity = tryResolvePackageIdentity(sourceSpec, cwd);
	const matches = loadConfiguredPackageSpecs(cwd)
		.map((entry) => ({
			scope: entry.scope,
			cwd: entry.cwd,
			sourceSpec: parsePackageSpec(entry.spec, entry.cwd)[0],
		}))
		.filter((entry) => {
			if (entry.sourceSpec === sourceSpec) {
				return true;
			}
			if (!requestedIdentity) {
				return false;
			}
			const entryIdentity = tryResolvePackageIdentity(
				entry.sourceSpec,
				entry.cwd,
			);
			return entryIdentity === requestedIdentity;
		});

	for (const scope of ["local", "project", "user"] as const) {
		const match = matches.find((entry) => entry.scope === scope);
		if (match) {
			return match;
		}
	}
	return null;
}

function tryResolvePackageIdentity(
	sourceSpec: string,
	cwd: string,
): string | null {
	try {
		return formatPackageSource(parsePackageSource(sourceSpec, cwd));
	} catch {
		return null;
	}
}

function formatInspectReport(inspected: InspectedPackage, cwd: string): string {
	const lines = ["Maestro Package Inspection:"];
	lines.push(`  Source: ${inspected.sourceSpec}`);
	lines.push(`  Resolved: ${formatPackageSource(inspected.source)}`);
	lines.push(`  Type: ${inspected.source.type}`);
	lines.push(`  Path: ${formatDisplayPath(inspected.resolvedPath, cwd)}`);

	if (!inspected.discovered) {
		lines.push("  Result: No valid package.json found");
		return lines.join("\n");
	}

	const { packageJson, isMaestroPackage, errors } = inspected.discovered;
	lines.push(`  Name: ${packageJson.name}`);
	if (packageJson.version) {
		lines.push(`  Version: ${packageJson.version}`);
	}
	lines.push(`  Maestro keyword: ${isMaestroPackage ? "yes" : "no"}`);
	lines.push(`  Manifest: ${packageJson.maestro ? "present" : "missing"}`);

	const manifest = packageJson.maestro;
	if (manifest) {
		lines.push("  Manifest paths:");
		lines.push(`    Extensions: ${formatManifestPaths(manifest.extensions)}`);
		lines.push(`    Skills: ${formatManifestPaths(manifest.skills)}`);
		lines.push(`    Prompts: ${formatManifestPaths(manifest.prompts)}`);
		lines.push(`    Themes: ${formatManifestPaths(manifest.themes)}`);
	}

	const issues = collectPackageValidationIssues(inspected);
	if (issues.length > 0) {
		lines.push("  Validation issues:");
		for (const issue of issues) {
			lines.push(`    - ${issue}`);
		}
	}

	if (inspected.resources) {
		lines.push("  Resources:");
		lines.push(
			`    Extensions: ${formatResourceSummary(inspected.resources.extensions)}`,
		);
		lines.push(
			`    Skills: ${formatResourceSummary(inspected.resources.skills)}`,
		);
		lines.push(
			`    Prompts: ${formatResourceSummary(inspected.resources.prompts)}`,
		);
		lines.push(
			`    Themes: ${formatResourceSummary(inspected.resources.themes)}`,
		);
	}

	return lines.join("\n");
}

function formatConfiguredPackageList(
	reports: ConfiguredPackageReport[],
	cwd: string,
): string {
	const lines = ["Configured Maestro Packages:"];

	for (const [index, report] of reports.entries()) {
		lines.push(`${index + 1}. [${report.entry.scope}] ${report.sourceSpec}`);
		lines.push(`   Config: ${formatDisplayPath(report.entry.configPath, cwd)}`);

		const filters = formatFilters(report.filters);
		if (filters) {
			lines.push(`   Filters: ${filters}`);
		}

		if (report.error) {
			lines.push(`   Error: ${report.error}`);
			continue;
		}

		const inspected = report.inspected;
		if (!inspected) {
			lines.push("   Error: Failed to inspect configured package.");
			continue;
		}

		lines.push(`   Resolved: ${formatPackageSource(inspected.source)}`);
		lines.push(`   Path: ${formatDisplayPath(inspected.resolvedPath, cwd)}`);

		if (!inspected.discovered) {
			lines.push("   Result: No valid package.json found");
			continue;
		}

		lines.push(`   Name: ${inspected.discovered.packageJson.name}`);
		lines.push(
			`   Resources: extensions=${inspected.resources?.extensions.length ?? 0}, skills=${inspected.resources?.skills.length ?? 0}, prompts=${inspected.resources?.prompts.length ?? 0}, themes=${inspected.resources?.themes.length ?? 0}`,
		);
	}

	return lines.join("\n");
}

function formatValidationSuccess(
	inspected: InspectedPackage,
	cwd: string,
): string {
	const lines = ["Package validation passed."];
	lines.push(
		`  Name: ${inspected.discovered?.packageJson.name ?? inspected.sourceSpec}`,
	);
	lines.push(`  Source: ${inspected.sourceSpec}`);
	lines.push(`  Path: ${formatDisplayPath(inspected.resolvedPath, cwd)}`);
	if (inspected.resources) {
		lines.push("  Resources:");
		lines.push(`    Extensions: ${inspected.resources.extensions.length}`);
		lines.push(`    Skills: ${inspected.resources.skills.length}`);
		lines.push(`    Prompts: ${inspected.resources.prompts.length}`);
		lines.push(`    Themes: ${inspected.resources.themes.length}`);
	}
	return lines.join("\n");
}

function formatRefreshSuccess(inspected: InspectedPackage): string {
	const lines = ["Package refresh completed."];
	lines.push(`  Source: ${inspected.sourceSpec}`);
	lines.push(`  Resolved: ${formatPackageSource(inspected.source)}`);
	lines.push(`  Type: ${inspected.source.type}`);
	lines.push(`  Path: ${inspected.resolvedPath}`);
	if (inspected.discovered?.packageJson.name) {
		lines.push(`  Name: ${inspected.discovered.packageJson.name}`);
	}
	return lines.join("\n");
}

function formatRefreshAllSuccess(
	report: ConfiguredPackageRefreshReport,
): string {
	const lines = ["Configured package refresh completed."];
	lines.push(`  Remote packages: ${report.remoteCount}`);
	lines.push(`  Local packages skipped: ${report.localCount}`);

	if (report.refreshed.length === 0) {
		lines.push("  Result: No configured remote packages to refresh.");
		return lines.join("\n");
	}

	for (const entry of report.refreshed) {
		lines.push(`  - ${entry.source}`);
		lines.push(`    Scopes: ${entry.scopes.join(", ")}`);
		if (entry.error) {
			lines.push(`    Error: ${entry.error}`);
			continue;
		}
		if (entry.inspection) {
			lines.push(`    Path: ${entry.inspection.resolvedPath}`);
			if (entry.inspection.discovered?.packageJson.name) {
				lines.push(`    Name: ${entry.inspection.discovered.packageJson.name}`);
			}
		}
		if (entry.issues.length > 0) {
			lines.push(`    Issues: ${entry.issues.join(" | ")}`);
		}
	}

	return lines.join("\n");
}

function formatValidationFailure(
	inspected: InspectedPackage,
	issues: string[],
	cwd: string,
): string {
	const lines = ["Package validation failed."];
	lines.push(`  Source: ${inspected.sourceSpec}`);
	lines.push(`  Path: ${formatDisplayPath(inspected.resolvedPath, cwd)}`);
	for (const issue of issues) {
		lines.push(`  - ${issue}`);
	}
	return lines.join("\n");
}

function formatManifestPaths(paths: unknown): string {
	if (paths === undefined) {
		return "(none)";
	}
	if (!Array.isArray(paths)) {
		return "(invalid)";
	}
	if (paths.length === 0) {
		return "(none)";
	}
	return paths.join(", ");
}

function formatFilters(filters: ResourceFilters | undefined): string | null {
	if (!filters) {
		return null;
	}

	const segments: string[] = [];
	for (const key of ["extensions", "skills", "prompts", "themes"] as const) {
		const values = filters[key];
		if (values && values.length > 0) {
			segments.push(`${key}=${values.join(",")}`);
		}
	}

	return segments.length > 0 ? segments.join(" ") : null;
}

function formatResourceSummary(paths: string[]): string {
	if (paths.length === 0) {
		return "0";
	}
	return `${paths.length} (${paths.map((path) => basename(path)).join(", ")})`;
}

function formatDisplayPath(path: string, cwd: string): string {
	const relativePath = relative(cwd, path);
	if (!relativePath || relativePath.startsWith("..")) {
		return path;
	}
	return relativePath;
}

function showPackageHelp(deps: PackageCommandDeps): void {
	publishOutput(
		deps,
		`Package Commands:
  /package add <source>      Add a configured Maestro package
  /package list               List configured Maestro packages
  /package remove <source>   Remove a configured Maestro package
  /package refresh [source]  Refresh one or all configured remote package caches
  /package inspect <source>   Inspect a Maestro package source
  /package validate <source>  Validate a Maestro package source
  /package <source>           Shorthand for inspect

Options:
  --scope local|project|user

Sources:
  local:./path
  ./relative/path
  /absolute/path
  git:github.com/org/repo@ref

Alias: /plugin`,
	);
}

function publishOutput(deps: PackageCommandDeps, content: string): void {
	deps.addContent(content);
	deps.requestRender();
}
