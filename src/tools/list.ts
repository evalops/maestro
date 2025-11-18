import { stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { Type } from "@sinclair/typebox";
import { glob } from "glob";
import { createTool } from "./tool-dsl.js";

function expandPath(path: string): string {
	if (path === "~") {
		return process.env.HOME || path;
	}
	if (path.startsWith("~/")) {
		return (process.env.HOME || "") + path.slice(1);
	}
	return path;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

type ListToolDetails = {
	format: "text" | "json";
	includeMetadata: boolean;
	limit: number;
	truncated: boolean;
};

const listSchema = Type.Object({
	path: Type.Optional(
		Type.String({
			description:
				"Directory to list (relative or absolute). Defaults to current directory.",
			minLength: 1,
		}),
	),
	pattern: Type.Optional(
		Type.String({
			description: "Glob pattern relative to the directory. Defaults to *",
			minLength: 1,
		}),
	),
	limit: Type.Optional(
		Type.Integer({
			description:
				"Maximum number of entries to return (1-500). Defaults to 200.",
			minimum: 1,
			maximum: MAX_LIMIT,
		}),
	),
	includeHidden: Type.Optional(
		Type.Boolean({
			description: "Whether to include dotfiles (hidden files)",
		}),
	),
	maxDepth: Type.Optional(
		Type.Integer({
			description: "Maximum directory depth to traverse (0 = unlimited)",
			minimum: 0,
			maximum: 10,
		}),
	),
	includeMetadata: Type.Optional(
		Type.Boolean({
			description: "Include file size and modified timestamps",
			default: false,
		}),
	),
	format: Type.Optional(
		Type.Union([Type.Literal("text"), Type.Literal("json")], {
			description: "Output format",
			default: "text",
		}),
	),
	sortBy: Type.Optional(
		Type.Union(
			[
				Type.Literal("name"),
				Type.Literal("type"),
				Type.Literal("size"),
				Type.Literal("mtime"),
			],
			{
				description: "Sort results by this field",
				default: "name",
			},
		),
	),
	sortDirection: Type.Optional(
		Type.Union([Type.Literal("asc"), Type.Literal("desc")], {
			description: "Sort direction",
			default: "asc",
		}),
	),
});

export const listTool = createTool<typeof listSchema, ListToolDetails>({
	name: "list",
	label: "list",
	description:
		"List files and directories in a path using safe glob patterns. Supports limiting and optional dotfiles.",
	schema: listSchema,
	async run(
		{
			path = ".",
			pattern = "*",
			limit = DEFAULT_LIMIT,
			includeHidden = false,
			maxDepth,
			includeMetadata = false,
			format = "text",
			sortBy = "name",
			sortDirection = "asc",
		},
		{ signal, respond },
	) {
		if (signal?.aborted) {
			throw new Error("Operation aborted");
		}

		const resolvedPath = resolvePath(expandPath(path));
		const safeLimit = Math.min(
			Math.max(Math.floor(limit || DEFAULT_LIMIT), 1),
			MAX_LIMIT,
		);
		const needsStats =
			includeMetadata || sortBy === "size" || sortBy === "mtime";

		try {
			const globOptions: Parameters<typeof glob>[1] = {
				cwd: resolvedPath,
				dot: includeHidden,
				mark: true,
				nodir: false,
			};
			if (typeof maxDepth === "number" && maxDepth > 0) {
				globOptions.maxDepth = maxDepth;
			}
			const entries = (await glob(pattern || "*", globOptions)) as string[];

			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const annotated = await Promise.all(
				entries.map(async (entry) => {
					const normalized = entry.endsWith("/") ? entry.slice(0, -1) : entry;
					const absolute = resolvePath(resolvedPath, normalized);
					let size: number | undefined;
					let mtimeMs: number | undefined;
					if (needsStats) {
						try {
							const stats = await stat(absolute);
							size = stats.size;
							mtimeMs = stats.mtimeMs;
						} catch {
							// ignore stat errors
						}
					}
					return {
						path: entry,
						isDirectory: entry.endsWith("/"),
						size,
						mtimeMs,
					};
				}),
			);

			const sorted = annotated.sort((a, b) => {
				let comparison = 0;
				switch (sortBy) {
					case "type":
						comparison = Number(b.isDirectory) - Number(a.isDirectory);
						break;
					case "size":
						comparison = (a.size ?? 0) - (b.size ?? 0);
						break;
					case "mtime":
						comparison = (a.mtimeMs ?? 0) - (b.mtimeMs ?? 0);
						break;
					default:
						comparison = a.path.localeCompare(b.path);
				}
				return sortDirection === "desc" ? -comparison : comparison;
			});

			const limitedEntries = sorted.slice(0, safeLimit);
			const truncated = sorted.length > limitedEntries.length;

			const summary: string[] = [
				`Directory: ${resolvedPath}`,
				`Pattern: ${pattern || "*"}`,
				`Results: ${limitedEntries.length}${truncated ? ` of ${sorted.length}` : ""}`,
				`Sorted by: ${sortBy} (${sortDirection})`,
			];
			if (includeHidden) {
				summary.push("Including hidden files");
			}
			if (typeof maxDepth === "number" && maxDepth > 0) {
				summary.push(`Max depth: ${maxDepth}`);
			}
			if (truncated) {
				summary.push(
					`Use a higher limit (max ${MAX_LIMIT}) or refine the pattern to see more entries`,
				);
			}

			let body: string;
			if (format === "json") {
				const payload = limitedEntries.map((entry) => ({
					path: entry.path,
					type: entry.isDirectory ? "directory" : "file",
					size: entry.size ?? null,
					modified: entry.mtimeMs
						? new Date(entry.mtimeMs).toISOString()
						: null,
				}));
				body = JSON.stringify(payload, null, 2);
			} else {
				const lines = limitedEntries.length
					? limitedEntries.map((entry) => {
							let line = `• ${entry.path}${entry.isDirectory ? " (dir)" : ""}`;
							if (includeMetadata) {
								const sizeText = entry.isDirectory
									? "—"
									: (entry.size?.toLocaleString() ?? "-");
								const modifiedText = entry.mtimeMs
									? new Date(entry.mtimeMs).toLocaleString()
									: "-";
								line += ` | size: ${sizeText} | modified: ${modifiedText}`;
							}
							return line;
						})
					: ["(no matches)"];
				body = lines.join("\n");
			}

			const text = `${summary.join("\n")}

${body}`;

			return respond
				.text(text)
				.detail({ format, includeMetadata, limit: safeLimit, truncated });
		} catch (error: unknown) {
			const message =
				error instanceof Error
					? error.message
					: "Unknown error while listing files";
			return respond.text(`Error listing ${resolvedPath}: ${message}`);
		}
	},
});
