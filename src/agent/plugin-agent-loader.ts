import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { ConfiguredPackageRuntimeOptions } from "../packages/runtime.js";
import { loadConfiguredPackageResources } from "../packages/runtime.js";
import type { PluginAgentModeMetadata } from "./plugin-agent-registry.js";

const AGENT_METADATA_FILE = "agent.json";
const MAX_AGENT_METADATA_BYTES = 64 * 1024;
const KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface LoadedPluginAgentModeMetadata extends PluginAgentModeMetadata {
	readonly directory: string;
	readonly scope: "user" | "project";
}

export interface PluginAgentMetadataLoadResult {
	metadata: readonly LoadedPluginAgentModeMetadata[];
	errors: readonly string[];
}

function isContainedPath(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function loadMetadataDirectory(
	directory: string,
	scope: "user" | "project",
): LoadedPluginAgentModeMetadata {
	const metadataPath = resolve(directory, AGENT_METADATA_FILE);
	if (!existsSync(metadataPath) || !statSync(metadataPath).isFile()) {
		throw new Error(`Missing ${AGENT_METADATA_FILE}`);
	}
	if (statSync(metadataPath).size > MAX_AGENT_METADATA_BYTES) {
		throw new Error(`${AGENT_METADATA_FILE} exceeds 64 KiB`);
	}
	const value = JSON.parse(readFileSync(metadataPath, "utf8")) as {
		key?: unknown;
		label?: unknown;
		entry?: unknown;
	};
	if (typeof value.key !== "string" || !KEY_PATTERN.test(value.key)) {
		throw new Error("Agent key must be lowercase kebab-case");
	}
	if (value.key !== basename(directory)) {
		throw new Error("Agent key must match its directory name");
	}
	if (typeof value.label !== "string" || !value.label.trim()) {
		throw new Error("Agent label must be non-empty");
	}
	if (typeof value.entry !== "string" || !value.entry.trim()) {
		throw new Error("Agent entry must be non-empty");
	}
	const realDirectory = realpathSync(directory);
	const entryPath = resolve(realDirectory, value.entry);
	if (!existsSync(entryPath) || !statSync(entryPath).isFile()) {
		throw new Error(`Agent entry does not exist: ${value.entry}`);
	}
	const realEntry = realpathSync(entryPath);
	if (!isContainedPath(realDirectory, realEntry)) {
		throw new Error("Agent entry must remain inside its resource directory");
	}
	return Object.freeze({
		key: value.key,
		label: value.label.trim(),
		entry: realEntry,
		directory: realDirectory,
		scope,
	});
}

export function loadPluginAgentMetadataFromDirectories(input: {
	user?: readonly string[];
	project?: readonly string[];
	initialErrors?: readonly string[];
}): PluginAgentMetadataLoadResult {
	const metadata: LoadedPluginAgentModeMetadata[] = [];
	const errors = [...(input.initialErrors ?? [])];
	const seen = new Set<string>();
	for (const scope of ["user", "project"] as const) {
		for (const directory of input[scope] ?? []) {
			try {
				const loaded = loadMetadataDirectory(directory, scope);
				if (seen.has(loaded.key)) {
					throw new Error(`Duplicate plugin agent key: ${loaded.key}`);
				}
				seen.add(loaded.key);
				metadata.push(loaded);
			} catch (error) {
				errors.push(
					`${directory}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}
	return Object.freeze({
		metadata: Object.freeze(metadata),
		errors: Object.freeze(errors),
	});
}

export function loadConfiguredPluginAgentMetadata(
	workspaceDir: string,
	options: ConfiguredPackageRuntimeOptions = {},
): PluginAgentMetadataLoadResult {
	const resources = loadConfiguredPackageResources(workspaceDir, options);
	return loadPluginAgentMetadataFromDirectories({
		user: resources.agents.user,
		project: resources.agents.project,
		initialErrors: resources.errors,
	});
}
