import { existsSync, readFileSync, readdirSync } from "node:fs";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import yaml from "js-yaml";
import type { ComposerConfig, LoadedComposer } from "./types.js";

const PERSONAL_DIR = join(homedir(), ".composer", "composers");
const PROJECT_DIR_NAME = ".composer/composers";

function parseYaml(content: string): Record<string, unknown> | null {
	try {
		const parsed = yaml.load(content);
		if (parsed && typeof parsed === "object") {
			return parsed as Record<string, unknown>;
		}
		return null;
	} catch {
		return null;
	}
}

function parseComposerFile(
	filePath: string,
	source: "project" | "personal",
): LoadedComposer | null {
	if (!existsSync(filePath)) {
		return null;
	}

	try {
		const content = readFileSync(filePath, "utf-8");
		const ext = extname(filePath).toLowerCase();
		let parsed: Record<string, unknown> | null = null;

		if (ext === ".json") {
			parsed = JSON.parse(content);
		} else if (ext === ".yaml" || ext === ".yml") {
			parsed = parseYaml(content);
		}

		if (!parsed || typeof parsed !== "object") {
			return null;
		}

		const config = parsed as unknown as ComposerConfig;
		if (!config.name || typeof config.name !== "string") {
			// Use filename as name if not specified
			config.name = basename(filePath, extname(filePath));
		}

		if (!config.description) {
			config.description = `Custom composer: ${config.name}`;
		}

		// Validate and normalize tools field
		if (config.tools !== undefined && !Array.isArray(config.tools)) {
			// Convert string to array (e.g., "read search" -> ["read", "search"])
			if (typeof config.tools === "string") {
				config.tools = (config.tools as string).split(/[\s,]+/).filter(Boolean);
			} else {
				config.tools = undefined;
			}
		}

		return {
			...config,
			source,
			filePath,
		};
	} catch (error) {
		console.warn(`[composers] Failed to parse ${filePath}:`, error);
		return null;
	}
}

function loadFromDirectory(
	dir: string,
	source: "project" | "personal",
): LoadedComposer[] {
	if (!existsSync(dir)) {
		return [];
	}

	try {
		const files = readdirSync(dir);
		const composers: LoadedComposer[] = [];

		for (const file of files) {
			const ext = extname(file).toLowerCase();
			if (ext !== ".json" && ext !== ".yaml" && ext !== ".yml") {
				continue;
			}

			const filePath = join(dir, file);

			// Prevent path traversal via symlinks
			try {
				const resolvedPath = realpathSync(filePath);
				if (!resolvedPath.startsWith(resolve(dir))) {
					console.warn(`[composers] Rejected path traversal attempt: ${file}`);
					continue;
				}
			} catch {
				// Skip files that can't be resolved (broken symlinks, etc.)
				continue;
			}

			const composer = parseComposerFile(filePath, source);
			if (composer && composer.enabled !== false) {
				composers.push(composer);
			}
		}

		return composers;
	} catch {
		return [];
	}
}

export function loadComposers(projectRoot?: string): LoadedComposer[] {
	const personalComposers = loadFromDirectory(PERSONAL_DIR, "personal");
	const projectComposers = projectRoot
		? loadFromDirectory(join(projectRoot, PROJECT_DIR_NAME), "project")
		: [];

	// Project composers override personal by name
	const composerMap = new Map<string, LoadedComposer>();

	for (const composer of personalComposers) {
		composerMap.set(composer.name, composer);
	}
	for (const composer of projectComposers) {
		composerMap.set(composer.name, composer);
	}

	return Array.from(composerMap.values());
}

export function getComposerByName(
	name: string,
	projectRoot?: string,
): LoadedComposer | undefined {
	const composers = loadComposers(projectRoot);
	return composers.find((c) => c.name === name);
}

export function getComposerDirs(projectRoot?: string): string[] {
	const dirs = [PERSONAL_DIR];
	if (projectRoot) {
		dirs.push(join(projectRoot, PROJECT_DIR_NAME));
	}
	return dirs;
}
