import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { relative, resolve as resolvePath, sep } from "node:path";
import { Type } from "@sinclair/typebox";
import { globSync } from "glob";
import { createTool } from "./tool-dsl.js";
import { ensureTool } from "./tools-manager.js";

function expandPath(filePath: string): string {
	if (filePath === "~") {
		return homedir();
	}
	if (filePath.startsWith("~/")) {
		return homedir() + filePath.slice(1);
	}
	return filePath;
}

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

		const searchPath = resolvePath(expandPath(searchDir || "."));
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

		// Include .gitignore files so fd respects them even outside git repos
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

		for (const gitignorePath of gitignoreFiles) {
			args.push("--ignore-file", gitignorePath);
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
