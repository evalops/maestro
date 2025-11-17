import { resolve as resolvePath } from "node:path";
import { Type } from "@sinclair/typebox";
import { glob } from "glob";
import type { TextContent } from "../agent/types.js";
import { createTypeboxTool } from "./typebox-tool.js";

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
});

export const listTool = createTypeboxTool({
	name: "list",
	label: "list",
	description:
		"List files and directories in a path using safe glob patterns. Supports limiting and optional dotfiles.",
	schema: listSchema,
	async execute(
		_toolCallId,
		{ path = ".", pattern = "*", limit = DEFAULT_LIMIT, includeHidden = false },
		signal,
	) {
		if (signal?.aborted) {
			throw new Error("Operation aborted");
		}

		const resolvedPath = resolvePath(expandPath(path));
		const safeLimit = Math.min(
			Math.max(Math.floor(limit || DEFAULT_LIMIT), 1),
			MAX_LIMIT,
		);

		try {
			const entries = await glob(pattern || "*", {
				cwd: resolvedPath,
				dot: includeHidden,
				mark: true,
				nodir: false,
			});

			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const limitedEntries = entries.slice(0, safeLimit);
			const truncated = entries.length > limitedEntries.length;

			const lines = limitedEntries.length
				? limitedEntries.map((entry) => `• ${entry}`)
				: ["(no matches)"];

			const summary: string[] = [
				`Directory: ${resolvedPath}`,
				`Pattern: ${pattern || "*"}`,
				`Results: ${limitedEntries.length}${truncated ? ` of ${entries.length}` : ""}`,
			];
			if (includeHidden) {
				summary.push("Including hidden files");
			}
			if (truncated) {
				summary.push(
					`Use a higher limit (max ${MAX_LIMIT}) or refine the pattern to see more entries`,
				);
			}

			const text = `${summary.join("\n")}

${lines.join("\n")}`;

			return {
				content: [{ type: "text", text } satisfies TextContent],
				details: undefined,
			};
		} catch (error: unknown) {
			const message =
				error instanceof Error
					? error.message
					: "Unknown error while listing files";
			return {
				content: [
					{
						type: "text",
						text: `Error listing ${resolvedPath}: ${message}`,
					} satisfies TextContent,
				],
				details: undefined,
			};
		}
	},
});
