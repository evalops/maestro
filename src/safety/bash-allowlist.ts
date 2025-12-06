import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { minimatch } from "minimatch";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("safety:bash-allowlist");

type AllowlistConfig = string[] | { allow?: string[] };

let cachedPatterns: string[] | null = null;
let cachedKey = "";

function getPaths(): string[] {
	const fromEnv = process.env.COMPOSER_BASH_ALLOWLIST_PATHS;
	const envPaths =
		fromEnv
			?.split(process.platform === "win32" ? ";" : ":")
			.filter(Boolean)
			.map((p) => p.trim()) ?? [];
	const workspacePath = join(process.cwd(), ".composer", "bash-allow.json");
	const userPath = join(homedir(), ".composer", "bash-allow.json");
	return [...envPaths, workspacePath, userPath];
}

function loadConfig(): string[] {
	const paths = getPaths();
	const key = paths.join("|");
	if (cachedPatterns && key === cachedKey) {
		return cachedPatterns;
	}

	const patterns: string[] = [];
	for (const path of paths) {
		if (!path || !existsSync(path)) continue;
		try {
			const raw = readFileSync(path, "utf-8");
			const parsed = JSON.parse(raw) as AllowlistConfig;
			const entries = Array.isArray(parsed)
				? parsed
				: Array.isArray(parsed.allow)
					? parsed.allow
					: [];
			for (const entry of entries) {
				if (typeof entry === "string" && entry.trim()) {
					patterns.push(entry.trim());
				}
			}
		} catch (error) {
			logger.warn("Failed to load bash allowlist", {
				path,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	cachedPatterns = patterns;
	cachedKey = key;
	return patterns;
}

export function isCommandAllowlisted(command: string): boolean {
	const patterns = loadConfig();
	return patterns.some((pattern) =>
		minimatch(command, pattern, {
			matchBase: true,
			nocase: true,
			dot: true,
		}),
	);
}
