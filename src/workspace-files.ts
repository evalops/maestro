import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

let cachedFiles: string[] | null = null;
let cachedAt = 0;

function runRgFiles(cwd: string): string[] | null {
	const result = spawnSync("rg", ["--files"], {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status === 0 && result.stdout) {
		return result.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
	}
	return null;
}

function runFindFiles(cwd: string): string[] {
	const result = spawnSync("find", [".", "-type", "f"], {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status === 0 && result.stdout) {
		return result.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
	}
	return [];
}

export function getWorkspaceFiles(limit = 2000): string[] {
	const now = Date.now();
	const cwd = resolve(process.cwd());

	// Refresh cache every 30 seconds
	if (cachedFiles && now - cachedAt < 30_000) {
		return cachedFiles.slice(0, limit);
	}

	let files = runRgFiles(cwd);
	if (!files) {
		files = runFindFiles(cwd);
	}

	if (!files) {
		cachedFiles = [];
		cachedAt = now;
		return [];
	}

	const normalized = files
		.map((file) => file.replace(/^[.][/\\]/, ""))
		.filter((file) => file.length > 0);

	cachedFiles = normalized.slice(0, limit);
	cachedAt = now;
	return cachedFiles;
}
