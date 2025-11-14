import { mkdir, writeFile } from "node:fs/promises";
import * as os from "node:os";
import { dirname, resolve as resolvePath } from "node:path";
import { z } from "zod";
import { createZodTool } from "./zod-tool.js";

/**
 * Expand ~ to home directory
 */
function expandPath(filePath: string): string {
	if (filePath === "~") {
		return os.homedir();
	}
	if (filePath.startsWith("~/")) {
		return os.homedir() + filePath.slice(1);
	}
	return filePath;
}

const writeSchema = z
	.object({
		path: z
			.string({
				description: "Path to the file to write (relative or absolute)",
			})
			.min(1, "Path must not be empty"),
		content: z
			.string({ description: "Content to write to the file" })
			.default(""),
	})
	.strict();

export const writeTool = createZodTool({
	name: "write",
	label: "write",
	description:
		"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
	schema: writeSchema,
	async execute(_toolCallId, { path, content }, signal) {
		const absolutePath = resolvePath(expandPath(path));
		const dir = dirname(absolutePath);

		return new Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: undefined;
		}>((resolve, reject) => {
			if (signal?.aborted) {
				reject(new Error("Operation aborted"));
				return;
			}

			let aborted = false;

			const onAbort = () => {
				aborted = true;
				reject(new Error("Operation aborted"));
			};

			if (signal) {
				signal.addEventListener("abort", onAbort, { once: true });
			}

			(async () => {
				try {
					await mkdir(dir, { recursive: true });

					if (aborted) {
						return;
					}

					await writeFile(absolutePath, content, "utf-8");

					if (aborted) {
						return;
					}

					if (signal) {
						signal.removeEventListener("abort", onAbort);
					}

					resolve({
						content: [
							{
								type: "text",
								text: `Successfully wrote ${content.length} bytes to ${path}`,
							},
						],
						details: undefined,
					});
				} catch (error: unknown) {
					if (signal) {
						signal.removeEventListener("abort", onAbort);
					}

					if (!aborted) {
						reject(error instanceof Error ? error : new Error(String(error)));
					}
				}
			})();
		});
	},
});
