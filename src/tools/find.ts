/**
 * Find Tool - Fast File Discovery with fd
 *
 * This module provides a file search tool that uses `fd` (a fast alternative
 * to `find`) for discovering files by glob pattern. It respects .gitignore
 * files and falls back to glob when fd returns no results.
 *
 * ## Features
 *
 * - **Fast search**: Uses fd for performance on large codebases
 * - **Glob patterns**: Standard glob syntax (*.ts, **\/*.json, etc.)
 * - **Git-aware**: Automatically respects .gitignore files
 * - **Hidden files**: Optional inclusion of dotfiles
 * - **Path handling**: Supports nested patterns with path separators
 * - **Auto-download**: Automatically downloads fd if not available
 *
 * ## Pattern Examples
 *
 * | Pattern           | Matches                          |
 * |-------------------|----------------------------------|
 * | `*.ts`            | TypeScript files in current dir  |
 * | `**\/*.spec.ts`   | Test files anywhere              |
 * | `src/**\/*.json`  | JSON files under src/            |
 *
 * ## Fallback Behavior
 *
 * If fd returns no results (which can happen with certain patterns on
 * some platforms), the tool falls back to Node.js glob matching to
 * ensure results are returned.
 *
 * ## Limits
 *
 * - Default limit: 1000 results
 * - Maximum buffer: 10MB
 * - Truncation indicator when limit is reached
 *
 * ## Example
 *
 * ```typescript
 * // Find all TypeScript test files
 * findTool.execute('call-id', {
 *   pattern: '**\/*.spec.ts',
 *   path: 'src',
 *   limit: 100,
 * });
 * ```
 *
 * @module tools/find
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import {
	dirname,
	isAbsolute,
	relative,
	resolve as resolvePath,
	sep,
} from "node:path";
import { Type } from "@sinclair/typebox";
import { globSync } from "glob";
import { minimatch } from "minimatch";
import { getGitRoot } from "../utils/git.js";
import { expandTildePath } from "../utils/path-expansion.js";
import { createTool } from "./tool-dsl.js";
import { ensureTool } from "./tools-manager.js";

const findSchema = Type.Object({
	pattern: Type.String({
		description:
			"Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
	}),
	path: Type.Optional(
		Type.String({
			description: "Directory to search in (default: current directory)",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description: "Maximum number of results (default: 1000)",
		}),
	),
	includeHidden: Type.Optional(
		Type.Boolean({
			description: "Include hidden files (default: true)",
		}),
	),
});

const DEFAULT_LIMIT = 1000;
const FD_IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"] as const;

type FindToolDetails = {
	command: string;
	cwd: string;
	fileCount: number;
	truncated: boolean;
};

/** @internal */
export type GitignoreRule = {
	pattern: string;
	negated: boolean;
	directoryOnly: boolean;
	matchPrefix?: string;
};

function collectGitignoreFiles(searchPath: string): string[] {
	const gitignoreFiles = new Set<string>();
	const ancestorDirs: string[] = [];
	let currentDir = searchPath;
	while (true) {
		ancestorDirs.push(currentDir);
		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) {
			break;
		}
		currentDir = parentDir;
	}

	for (const dir of ancestorDirs.reverse()) {
		for (const fileName of FD_IGNORE_FILE_NAMES) {
			const ignoreFile = resolvePath(dir, fileName);
			if (existsSync(ignoreFile)) {
				gitignoreFiles.add(ignoreFile);
			}
		}
	}

	try {
		for (const fileName of FD_IGNORE_FILE_NAMES) {
			const nestedGitignores = globSync(`**/${fileName}`, {
				cwd: searchPath,
				dot: true,
				absolute: true,
				ignore: ["**/node_modules/**", "**/.git/**"],
			});
			for (const file of nestedGitignores) {
				gitignoreFiles.add(file);
			}
		}
	} catch {
		// Ignore glob errors
	}

	return [...gitignoreFiles];
}

function toGlobPath(path: string): string {
	return path.split(sep).join("/");
}

function relativePathStaysInside(path: string): boolean {
	return (
		path === "" ||
		(path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
	);
}

function scopeGitignorePattern(
	searchPath: string,
	ignoreDir: string,
	pattern: string,
	anchored: boolean,
): { matchPrefix?: string; pattern: string } | undefined {
	const ignoreDirFromSearch = relative(searchPath, ignoreDir);
	if (relativePathStaysInside(ignoreDirFromSearch)) {
		const relativeDir = toGlobPath(ignoreDirFromSearch);
		const prefix = relativeDir && relativeDir !== "." ? `${relativeDir}/` : "";
		return { pattern: `${prefix}${pattern}` };
	}

	const searchPathFromIgnoreDir = relative(ignoreDir, searchPath);
	if (!relativePathStaysInside(searchPathFromIgnoreDir)) {
		return undefined;
	}

	if (!anchored && !pattern.includes("/")) {
		return { pattern: `**/${pattern}` };
	}
	if (!anchored && pattern.startsWith("**/")) {
		return { pattern };
	}

	const searchPrefix = toGlobPath(searchPathFromIgnoreDir);
	if (!searchPrefix || searchPrefix === ".") {
		return { pattern };
	}
	const prefix = `${searchPrefix}/`;
	return pattern.startsWith(prefix)
		? { pattern: pattern.slice(prefix.length) }
		: { matchPrefix: searchPrefix, pattern };
}

function stripUnescapedTrailingWhitespace(line: string): string {
	let end = line.length;
	while (end > 0 && /\s/.test(line[end - 1] ?? "")) {
		let slashCount = 0;
		for (let index = end - 2; index >= 0 && line[index] === "\\"; index -= 1) {
			slashCount += 1;
		}
		if (slashCount % 2 === 1) {
			break;
		}
		end -= 1;
	}
	return line.slice(0, end);
}

function unescapeGitignorePattern(pattern: string): string {
	return pattern.replace(/\\([#!\t ])/g, "$1");
}

function collectGitignoreRules(
	searchPath: string,
	gitignoreFiles: string[],
): GitignoreRule[] {
	const rules: GitignoreRule[] = [];

	for (const gitignorePath of gitignoreFiles) {
		const ignoreDir = dirname(gitignorePath);

		let contents: string;
		try {
			contents = readFileSync(gitignorePath, "utf8");
		} catch {
			continue;
		}

		for (const rawLine of contents.split(/\r?\n/)) {
			let line = stripUnescapedTrailingWhitespace(rawLine);
			if (!line || line.startsWith("#")) {
				continue;
			}

			const negated = line.startsWith("!");
			if (negated) {
				line = line.slice(1);
				if (!line) {
					continue;
				}
			}
			const anchored = line.startsWith("/");
			const directoryOnly = line.endsWith("/");
			let pattern = unescapeGitignorePattern(
				line.replace(/^\/+/, "").replace(/\/+$/, ""),
			);
			if (!pattern) {
				continue;
			}

			if (!anchored && !pattern.includes("/")) {
				pattern = `**/${pattern}`;
			}

			const scopedPattern = scopeGitignorePattern(
				searchPath,
				ignoreDir,
				pattern,
				anchored,
			);
			if (!scopedPattern) {
				continue;
			}
			rules.push({
				pattern: scopedPattern.pattern,
				matchPrefix: scopedPattern.matchPrefix,
				negated,
				directoryOnly,
			});
		}
	}

	return rules;
}

function pathIsDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function pathAncestors(path: string): string[] {
	const parts = path.split("/").filter(Boolean);
	const ancestors: string[] = [];
	for (let index = 1; index < parts.length; index += 1) {
		ancestors.push(parts.slice(0, index).join("/"));
	}
	return ancestors;
}

function gitignoreRuleMatchPath(path: string, rule: GitignoreRule): string {
	return rule.matchPrefix
		? path === "."
			? rule.matchPrefix
			: `${rule.matchPrefix}/${path}`
		: path;
}

function matchesGitignoreSubject(
	path: string,
	rule: GitignoreRule,
	isDirectory: boolean,
): boolean {
	const matchPath = gitignoreRuleMatchPath(path, rule);
	const options = { dot: true, nonegate: true };
	if (rule.directoryOnly) {
		return isDirectory && minimatch(matchPath, rule.pattern, options);
	}
	return minimatch(matchPath, rule.pattern, options);
}

function evaluateGitignoreSubject(
	path: string,
	rules: GitignoreRule[],
	isDirectory: boolean,
): boolean {
	let ignored = false;
	for (const rule of rules) {
		if (matchesGitignoreSubject(path, rule, isDirectory)) {
			ignored = !rule.negated;
		}
	}
	return ignored;
}

/** @internal */
export function isIgnoredByGitignoreRules(
	relativePath: string,
	rules: GitignoreRule[],
	isDirectory = false,
): boolean {
	const normalizedPath = toGlobPath(relativePath);
	for (const ancestor of pathAncestors(normalizedPath)) {
		if (evaluateGitignoreSubject(ancestor, rules, true)) {
			return true;
		}
	}
	return evaluateGitignoreSubject(normalizedPath, rules, isDirectory);
}

function constrainGlobMatches(
	matches: string[],
	searchPath: string,
	rules: GitignoreRule[],
): string[] {
	const searchRoot = searchPath.endsWith(sep)
		? searchPath
		: `${searchPath}${sep}`;
	const constrained: string[] = [];
	for (const match of matches) {
		const resolved = resolvePath(match);
		if (resolved !== searchPath && !resolved.startsWith(searchRoot)) {
			continue;
		}
		const relativeMatch = relative(searchPath, resolved) || ".";
		if (
			isIgnoredByGitignoreRules(relativeMatch, rules, pathIsDirectory(resolved))
		) {
			continue;
		}
		constrained.push(resolved);
	}
	return constrained;
}

export const findTool = createTool<typeof findSchema, FindToolDetails>({
	name: "find",
	label: "find",
	description:
		"Search for files by glob pattern using fd. Returns matching file paths relative to the search directory. Respects .gitignore. Use this for fast file discovery across large codebases.",
	schema: findSchema,
	async run(params, { signal, respond }) {
		if (signal?.aborted) {
			throw new Error("Operation aborted");
		}

		const { pattern, path: searchDir, limit, includeHidden = true } = params;

		const fdPath = await ensureTool("fd", true);
		if (!fdPath) {
			return respond
				.error("fd is not available and could not be downloaded")
				.detail({
					command: "fd",
					cwd: process.cwd(),
					fileCount: 0,
					truncated: false,
				});
		}

		const searchPath = resolvePath(expandTildePath(searchDir || "."));
		const effectiveLimit = limit ?? DEFAULT_LIMIT;

		const args: string[] = [
			"--glob",
			"--color=never",
			"--max-results",
			String(effectiveLimit),
		];

		// If pattern includes path separators, match against the full path so nested globs work.
		if (pattern.includes("/") || pattern.includes("\\")) {
			args.push("--full-path");
		}

		if (includeHidden) {
			args.push("--hidden");
		}

		const gitRoot = getGitRoot(searchPath);
		const gitignoreFiles = gitRoot ? [] : collectGitignoreFiles(searchPath);
		const gitignoreRules = collectGitignoreRules(searchPath, gitignoreFiles);
		if (gitRoot) {
			// Force fd to honor repo-native ignore rules even if user config disables
			// VCS ignores, while keeping anchored patterns scoped to the repo root.
			args.push("--ignore-vcs");
		} else {
			// Let fd discover .gitignore files in their native directories instead of
			// re-scoping them as current-directory --ignore-file inputs.
			args.push("--no-require-git");
		}

		args.push(pattern);

		const command = [fdPath, ...args].join(" ");

		const result = spawnSync(fdPath, args, {
			encoding: "utf-8",
			maxBuffer: 10 * 1024 * 1024,
			cwd: searchPath,
		});

		if (signal?.aborted) {
			throw new Error("Operation aborted");
		}

		if (result.error) {
			return respond
				.error(`Failed to run fd: ${result.error.message}`)
				.detail({ command, cwd: searchPath, fileCount: 0, truncated: false });
		}

		let output = result.stdout ?? "";

		if (result.status !== 0 && !output) {
			const errorMsg =
				result.stderr?.trim() || `fd exited with code ${result.status}`;
			return respond
				.error(errorMsg)
				.detail({ command, cwd: searchPath, fileCount: 0, truncated: false });
		}

		if (!output) {
			// Fallback to globbing when fd returns nothing (handles patterns with subdirectories on some platforms)
			const globMatches = globSync(pattern, {
				cwd: searchPath,
				dot: includeHidden,
				nodir: false,
				absolute: true,
			});
			const constrained = constrainGlobMatches(
				globMatches,
				searchPath,
				gitignoreRules,
			);

			if (constrained.length > 0) {
				const limited = constrained.slice(0, effectiveLimit);
				const truncated = constrained.length > effectiveLimit;
				const text = limited
					.map((abs) => relative(searchPath, abs) || ".")
					.join("\n");
				return respond
					.text(
						truncated
							? `${text}\n\n(truncated, ${effectiveLimit} results shown)`
							: text,
					)
					.detail({
						command,
						cwd: searchPath,
						fileCount: constrained.length,
						truncated,
					});
			}

			return respond
				.text("No files found matching pattern")
				.detail({ command, cwd: searchPath, fileCount: 0, truncated: false });
		}

		const lines = output.split("\n");
		const relativized: string[] = [];

		for (const rawLine of lines) {
			const line = rawLine.replace(/\r$/, "");
			if (!line) {
				continue;
			}

			let relativePath = line;
			if (line.endsWith("\\")) {
				// Normalize Windows-style trailing backslash to a single forward slash
				relativePath = `${line.slice(0, -1)}/`;
			}

			if (relativePath) {
				if (
					!gitRoot &&
					isIgnoredByGitignoreRules(
						relativePath,
						gitignoreRules,
						pathIsDirectory(resolvePath(searchPath, relativePath)),
					)
				) {
					continue;
				}
				relativized.push(relativePath);
			}
		}

		if (!gitRoot && pattern.includes("**/")) {
			const searchRoot = searchPath.endsWith(sep)
				? searchPath
				: `${searchPath}${sep}`;
			const seen = new Set(relativized);
			for (const match of globSync(pattern, {
				cwd: searchPath,
				dot: includeHidden,
				nodir: false,
				absolute: true,
			})) {
				const resolved = resolvePath(match);
				if (resolved !== searchPath && !resolved.startsWith(searchRoot)) {
					continue;
				}
				const relativeMatch = relative(searchPath, resolved) || ".";
				if (
					isIgnoredByGitignoreRules(
						relativeMatch,
						gitignoreRules,
						pathIsDirectory(resolved),
					)
				) {
					continue;
				}
				if (!seen.has(relativeMatch)) {
					seen.add(relativeMatch);
					relativized.push(relativeMatch);
				}
			}
		}

		relativized.sort();
		output = relativized.slice(0, effectiveLimit).join("\n");
		const count = relativized.length;
		const truncated = count >= effectiveLimit;
		if (truncated) {
			output += `\n\n(truncated, ${effectiveLimit} results shown)`;
		}

		return respond
			.text(output)
			.detail({ command, cwd: searchPath, fileCount: count, truncated });
	},
});
