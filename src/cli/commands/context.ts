import { relative, resolve } from "node:path";
import chalk from "chalk";
import {
	type PromptProjectDocManifest,
	loadPromptProjectDocManifest,
} from "../../config/index.js";
import { getHomeDir } from "../../utils/path-expansion.js";

export interface ContextExplainOptions {
	cwd?: string;
	json?: boolean;
}

function formatPath(path: string, cwd: string, homeDir = getHomeDir()): string {
	const resolvedPath = resolve(path);
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(homeDir);
	if (resolvedPath === resolvedCwd) {
		return ".";
	}
	if (resolvedPath.startsWith(`${resolvedCwd}/`)) {
		return relative(resolvedCwd, resolvedPath);
	}
	if (resolvedPath === resolvedHome) {
		return "~";
	}
	if (resolvedPath.startsWith(`${resolvedHome}/`)) {
		return `~/${relative(resolvedHome, resolvedPath)}`;
	}
	return resolvedPath;
}

export function renderContextManifestSummary(
	manifest: PromptProjectDocManifest,
): string {
	const lines: string[] = [];
	lines.push(`Prompt context for ${manifest.cwd}`);
	const budget =
		manifest.maxBytes === undefined
			? `${manifest.bytesRead.toLocaleString()} bytes used (unlimited)`
			: `${manifest.bytesRead.toLocaleString()} / ${manifest.maxBytes.toLocaleString()} bytes used`;
	lines.push(`Budget: ${budget}`);
	lines.push(`Candidate order: ${manifest.candidates.join(", ")}`);
	lines.push("");

	if (manifest.entries.length === 0) {
		lines.push("Loaded files: none");
	} else {
		lines.push("Loaded files:");
		for (const entry of manifest.entries) {
			const flags = [
				entry.sourceKind,
				`${entry.bytesRead.toLocaleString()} bytes`,
				`sha256:${entry.contentHash.slice(0, 12)}`,
				entry.truncated ? "truncated" : null,
			].filter((flag): flag is string => Boolean(flag));
			lines.push(
				`${entry.precedenceIndex + 1}. ${formatPath(entry.path, manifest.cwd)} (${flags.join(", ")})`,
			);
			lines.push(`   scope: ${formatPath(entry.scopeDir, manifest.cwd)}`);
		}
	}

	if (manifest.diagnostics.length > 0) {
		lines.push("");
		lines.push("Diagnostics:");
		for (const diagnostic of manifest.diagnostics) {
			const location = diagnostic.path ?? diagnostic.scopeDir;
			const suffix = location ? ` [${formatPath(location, manifest.cwd)}]` : "";
			lines.push(
				`- ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}${suffix}`,
			);
		}
	}

	return lines.join("\n");
}

export async function handleContextCommand(
	subcommand?: string,
	args: string[] = [],
	options: ContextExplainOptions = {},
): Promise<void> {
	const command = subcommand ?? "explain";
	if (command !== "explain") {
		console.error(
			chalk.red(
				`Unknown context subcommand: ${command}. Try "maestro context explain"`,
			),
		);
		process.exit(1);
	}

	const cwd = resolve(
		options.cwd ?? args.find((arg) => !arg.startsWith("-")) ?? process.cwd(),
	);
	const manifest = loadPromptProjectDocManifest(cwd);
	if (options.json ?? args.includes("--json")) {
		console.log(JSON.stringify(manifest, null, 2));
		return;
	}

	console.log(renderContextManifestSummary(manifest));
}
