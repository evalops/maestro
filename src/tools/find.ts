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
import { existsSync } from "node:fs";
import { relative, resolve as resolvePath, sep } from "node:path";
import { Type } from "@sinclair/typebox";
import { globSync } from "glob";
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

type FindToolDetails = {
	command: string;
	cwd: string;
	fileCount: number;
	truncated: boolean;
};

function collectGitignoreFiles(searchPath: string): string[] {
	const gitignoreFiles = new Set<string>();

	const rootGitignore = resolvePath(searchPath, ".gitignore");
	if (existsSync(rootGitignore)) {
		gitignoreFiles.add(rootGitignore);
	}

	try {
		const nestedGitignores = globSync("**/.gitignore", {
			cwd: searchPath,
			dot: true,
			absolute: true,
			ignore: ["**/node_modules/**", "**/.git/**"],
		});
		for (const file of nestedGitignores) {
			gitignoreFiles.add(file);
		}
	} catch {
		// Ignore glob errors
	}

	return [...gitignoreFiles];
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

		if (getGitRoot(searchPath)) {
			// Force fd to honor repo-native ignore rules even if user config disables
			// VCS ignores, while keeping anchored patterns scoped to the repo root.
			args.push("--ignore-vcs");
		} else {
			for (const gitignorePath of collectGitignoreFiles(searchPath)) {
				args.push("--ignore-file", gitignorePath);
			}
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

		let output = result.stdout?.trim() || "";

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
			const searchRoot = searchPath.endsWith(sep)
				? searchPath
				: `${searchPath}${sep}`;
			const constrained = globMatches.filter((match) => {
				const resolved = resolvePath(match);
				return resolved === searchPath || resolved.startsWith(searchRoot);
			});

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
			const line = rawLine.replace(/\r$/, "").trim();
			if (!line) {
				continue;
			}

			let relativePath = line;
			if (line.endsWith("\\")) {
				// Normalize Windows-style trailing backslash to a single forward slash
				relativePath = `${line.slice(0, -1)}/`;
			}

			if (relativePath) {
				relativized.push(relativePath);
			}
		}

		output = relativized.join("\n");

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
