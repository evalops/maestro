/**
 * Write Tool - Create/overwrite files
 */

import { Type } from "@sinclair/typebox";
import type { Executor } from "../sandbox.js";
import type { AgentTool } from "./index.js";

function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

const writeSchema = Type.Object({
	label: Type.String({
		description: "Brief description of what you're writing (shown to user)",
	}),
	path: Type.String({
		description: "Path to the file to write (relative or absolute)",
	}),
	content: Type.String({ description: "Content to write to the file" }),
});

export function createWriteTool(
	executor: Executor,
): AgentTool<typeof writeSchema> {
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		parameters: writeSchema,
		execute: async (
			_toolCallId: string,
			args: Record<string, unknown>,
			signal?: AbortSignal,
		) => {
			const { path, content } = args as {
				label: string;
				path: string;
				content: string;
			};
			const dir = path.includes("/")
				? path.substring(0, path.lastIndexOf("/"))
				: ".";

			const cmd = `mkdir -p ${shellEscape(dir)} && printf '%s' ${shellEscape(content)} > ${shellEscape(path)}`;

			const result = await executor.exec(cmd, { signal });
			if (result.code !== 0) {
				throw new Error(result.stderr || `Failed to write file: ${path}`);
			}

			return {
				content: [
					{
						type: "text",
						text: `Successfully wrote ${content.length} bytes to ${path}`,
					},
				],
				details: undefined,
			};
		},
	};
}
