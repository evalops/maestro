import { existsSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import {
	type DiscoveredPackage,
	type MaestroManifest,
	type PackageResources,
	type PackageSource,
	discoverPackage,
	formatPackageSource,
	loadPackage,
	loadPackageResources,
	parsePackageSource,
	resolvePackageSource,
} from "../../packages/index.js";
import { parseCommandArguments } from "../../tools/shell-utils.js";
import type { CommandExecutionContext } from "./types.js";

const PACKAGE_USAGE = "/package [inspect|validate] <source>";

export interface PackageCommandDeps {
	cwd: string;
	addContent(content: string): void;
	requestRender(): void;
}

interface InspectedPackage {
	sourceSpec: string;
	source: PackageSource;
	resolvedPath: string;
	discovered: DiscoveredPackage | null;
	resources?: PackageResources;
}

export const PACKAGE_SUBCOMMANDS = [
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

		if (subcommand === "inspect" || subcommand === "validate") {
			if (tokens.length !== 2) {
				ctx.showError(`Usage: ${PACKAGE_USAGE}`);
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

function parsePackageCommandTokens(rawInput: string): string[] {
	const remainder = rawInput.replace(/^\/(?:package|plugin)\b/i, "").trim();
	if (!remainder) {
		return [];
	}
	return parseCommandArguments(remainder);
}

async function runPackageSubcommand(
	subcommand: "inspect" | "validate",
	sourceSpec: string,
	deps: PackageCommandDeps,
	ctx: CommandExecutionContext,
): Promise<void> {
	let inspected: InspectedPackage;
	try {
		inspected = await inspectPackage(sourceSpec, deps.cwd);
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

	const issues = collectValidationIssues(inspected);
	if (issues.length > 0) {
		publishOutput(deps, formatValidationFailure(inspected, issues, deps.cwd));
		return;
	}

	publishOutput(deps, formatValidationSuccess(inspected, deps.cwd));
}

async function inspectPackage(
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

function collectValidationIssues(inspected: InspectedPackage): string[] {
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

	const issues = collectValidationIssues(inspected);
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
  /package inspect <source>   Inspect a Maestro package source
  /package validate <source>  Validate a Maestro package source
  /package <source>           Shorthand for inspect

Sources:
  local:./path
  ./relative/path
  /absolute/path
  git:github.com/org/repo@ref
  npm:@scope/name@version

Alias: /plugin`,
	);
}

function publishOutput(deps: PackageCommandDeps, content: string): void {
	deps.addContent(content);
	deps.requestRender();
}
