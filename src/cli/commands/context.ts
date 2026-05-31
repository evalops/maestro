import { relative, resolve } from "node:path";
import chalk from "chalk";
import {
	type UnifiedContextManifest,
	type UnifiedContextManifestDiff,
	diffUnifiedContextManifests,
	loadUnifiedContextManifest,
} from "../../context/manifest.js";
import { getHomeDir } from "../../utils/path-expansion.js";

export interface ContextExplainOptions {
	cwd?: string;
	json?: boolean;
	liveMcp?: boolean;
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
	manifest: UnifiedContextManifest,
): string {
	const lines: string[] = [];
	lines.push(`Prompt context for ${manifest.cwd}`);
	const budget =
		manifest.projectDocs.maxBytes === undefined
			? `${manifest.projectDocs.bytesRead.toLocaleString()} bytes used (unlimited)`
			: `${manifest.projectDocs.bytesRead.toLocaleString()} / ${manifest.projectDocs.maxBytes.toLocaleString()} bytes used`;
	lines.push(`Budget: ${budget}`);
	lines.push(`Candidate order: ${manifest.projectDocs.candidates.join(", ")}`);
	lines.push("");

	const projectDocs = manifest.entries.filter(
		(entry) => entry.kind === "project_doc",
	);
	if (projectDocs.length === 0) {
		lines.push("Loaded files: none");
	} else {
		lines.push("Loaded files:");
		for (const entry of projectDocs) {
			const entryPath = entry.path ?? entry.id;
			const flags = [
				String(entry.metadata?.sourceKind ?? "project"),
				`${(entry.bytesRead ?? 0).toLocaleString()} bytes`,
				entry.contentHash ? `sha256:${entry.contentHash.slice(0, 12)}` : null,
				entry.metadata?.truncated ? "truncated" : null,
			].filter((flag): flag is string => Boolean(flag));
			lines.push(
				`${(entry.precedenceIndex ?? 0) + 1}. ${formatPath(entryPath, manifest.cwd)} (${flags.join(", ")})`,
			);
			if (entry.scopeDir) {
				lines.push(`   scope: ${formatPath(entry.scopeDir, manifest.cwd)}`);
			}
		}
	}

	const mcpEntries = manifest.entries.filter((entry) =>
		entry.kind.startsWith("mcp_"),
	);
	if (mcpEntries.length > 0) {
		lines.push("");
		lines.push("MCP context:");
		for (const entry of mcpEntries) {
			const location =
				entry.uri ?? entry.promptName ?? entry.serverName ?? entry.id;
			lines.push(`- ${entry.kind} ${location} (${entry.status})`);
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

export function renderContextManifestDiff(
	diff: UnifiedContextManifestDiff,
): string {
	const lines: string[] = [];
	lines.push("Context diff");
	lines.push(`Before: ${diff.beforeCwd}`);
	lines.push(`After:  ${diff.afterCwd}`);
	lines.push("");
	lines.push(
		`Summary: ${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed, ${diff.unchanged.length} unchanged`,
	);

	const appendGroup = (
		title: string,
		prefix: string,
		entries: UnifiedContextManifestDiff["added"],
	): void => {
		if (entries.length === 0) {
			return;
		}
		lines.push("");
		lines.push(`${title}:`);
		for (const entry of entries) {
			const changes =
				entry.changes && entry.changes.length > 0
					? ` [${entry.changes.join(", ")}]`
					: "";
			lines.push(`${prefix} ${entry.kind} ${entry.label}${changes}`);
		}
	};

	appendGroup("Added", "+", diff.added);
	appendGroup("Removed", "-", diff.removed);
	appendGroup("Changed", "~", diff.changed);

	if (diff.diagnostics.length > 0) {
		lines.push("");
		lines.push("Diagnostics:");
		for (const diagnostic of diff.diagnostics) {
			lines.push(
				`- ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`,
			);
		}
	}

	return lines.join("\n");
}

async function loadContextManifestForCommand(
	cwd: string,
	liveMcp: boolean,
): Promise<UnifiedContextManifest> {
	if (!liveMcp) {
		return loadUnifiedContextManifest(cwd);
	}

	const { loadMcpConfig, mcpManager } = await import("../../mcp/index.js");
	try {
		await mcpManager.configure(loadMcpConfig(cwd, { includeEnvLimits: true }));
		await mcpManager.connectAll();
		return loadUnifiedContextManifest(cwd, {
			mcpStatus: mcpManager.getStatus(),
		});
	} finally {
		await mcpManager.disconnectAll();
	}
}

async function loadContextManifestPairForCommand(
	beforeCwd: string,
	afterCwd: string,
	liveMcp: boolean,
): Promise<{ before: UnifiedContextManifest; after: UnifiedContextManifest }> {
	if (!liveMcp) {
		return {
			before: loadUnifiedContextManifest(beforeCwd),
			after: loadUnifiedContextManifest(afterCwd),
		};
	}

	const { loadMcpConfig, mcpManager } = await import("../../mcp/index.js");
	try {
		await mcpManager.configure(
			loadMcpConfig(beforeCwd, { includeEnvLimits: true }),
		);
		await mcpManager.connectAll();
		const before = loadUnifiedContextManifest(beforeCwd, {
			mcpStatus: mcpManager.getStatus(),
		});

		await mcpManager.configure(
			loadMcpConfig(afterCwd, { includeEnvLimits: true }),
		);
		await mcpManager.connectAll();
		const after = loadUnifiedContextManifest(afterCwd, {
			mcpStatus: mcpManager.getStatus(),
		});

		return { before, after };
	} finally {
		await mcpManager.disconnectAll();
	}
}

export async function handleContextCommand(
	subcommand?: string,
	args: string[] = [],
	options: ContextExplainOptions = {},
): Promise<void> {
	const liveMcp = options.liveMcp ?? args.includes("--live-mcp");
	const command = subcommand ?? "explain";
	if (command !== "explain" && command !== "diff") {
		console.error(
			chalk.red(
				`Unknown context subcommand: ${command}. Try "maestro context explain"`,
			),
		);
		process.exit(1);
	}

	const positionalArgs = args.filter((arg) => !arg.startsWith("-"));

	if (command === "diff") {
		const beforeCwd = resolve(
			options.cwd ??
				(positionalArgs.length >= 2 ? positionalArgs[0]! : process.cwd()),
		);
		const afterCwd = resolve(
			positionalArgs.length >= 2
				? positionalArgs[1]!
				: (positionalArgs[0] ?? process.cwd()),
		);
		const { before, after } = await loadContextManifestPairForCommand(
			beforeCwd,
			afterCwd,
			liveMcp,
		);
		const diff = diffUnifiedContextManifests(before, after);
		if (options.json ?? args.includes("--json")) {
			console.log(JSON.stringify(diff, null, 2));
			return;
		}
		console.log(renderContextManifestDiff(diff));
		return;
	}

	const cwd = resolve(options.cwd ?? positionalArgs[0] ?? process.cwd());
	const manifest = await loadContextManifestForCommand(cwd, liveMcp);
	if (options.json ?? args.includes("--json")) {
		console.log(JSON.stringify(manifest, null, 2));
		return;
	}

	console.log(renderContextManifestSummary(manifest));
}
