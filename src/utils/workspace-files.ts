import { spawnSync } from "node:child_process";
import { join, relative, resolve, sep } from "node:path";

const cache = new Map<string, { files: string[]; cachedAt: number }>();

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
	const pruneDirs = [
		".git",
		"node_modules",
		".maestro",
		".next",
		".turbo",
		".nx",
		"dist",
		"build",
		"coverage",
		".cache",
	];
	const pruneArgs: string[] = ["("];
	for (const [index, dir] of pruneDirs.entries()) {
		if (index > 0) {
			pruneArgs.push("-o");
		}
		pruneArgs.push("-path", `./${dir}`);
	}
	pruneArgs.push(")", "-prune", "-o", "-type", "f", "-print");

	const result = spawnSync("find", [".", ...pruneArgs], {
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

function runGitFiles(cwd: string): string[] | null {
	const rootResult = spawnSync("git", ["rev-parse", "--show-toplevel"], {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (rootResult.status !== 0 || !rootResult.stdout) {
		return null;
	}
	const root = rootResult.stdout.trim();
	if (!root) return null;

	const listResult = spawnSync(
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard"],
		{
			cwd: root,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	if (listResult.status !== 0 || !listResult.stdout) {
		return null;
	}
	const files = listResult.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (files.length === 0) return [];

	if (root === cwd) {
		return files;
	}

	const cwdWithSep = cwd.endsWith(sep) ? cwd : `${cwd}${sep}`;
	const scoped: string[] = [];
	for (const file of files) {
		const absolutePath = join(root, file);
		if (absolutePath === cwd || absolutePath.startsWith(cwdWithSep)) {
			const relPath = relative(cwd, absolutePath);
			if (relPath && !relPath.startsWith("..")) {
				scoped.push(relPath);
			}
		}
	}
	return scoped;
}

export function getWorkspaceFiles(limit = 2000, cwdInput?: string): string[] {
	const now = Date.now();
	const cwd = resolve(cwdInput ?? process.cwd());

	// Refresh cache every 30 seconds
	const cached = cache.get(cwd);
	if (cached && now - cached.cachedAt < 30_000) {
		return cached.files.slice(0, limit);
	}

	let files = runRgFiles(cwd);
	if (files === null) {
		files = runGitFiles(cwd);
	}
	if (files === null) {
		files = runFindFiles(cwd);
	}

	if (files === null) {
		cache.set(cwd, { files: [], cachedAt: now });
		return [];
	}

	const normalized = files
		.map((file) => file.replace(/^[.][/\\]/, ""))
		.filter((file) => file.length > 0);

	cache.set(cwd, { files: normalized, cachedAt: now });
	return normalized.slice(0, limit);
}
