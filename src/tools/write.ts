import { constants } from "node:fs";
import {
	access,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import * as os from "node:os";
import { dirname, resolve as resolvePath } from "node:path";
import { Type } from "@sinclair/typebox";
import { collectDiagnostics } from "../lsp/index.js";
import {
	requirePlanCheck,
	runValidatorsOnSuccess,
} from "../safety/safe-mode.js";
import type { ValidatorRunResult } from "../safety/safe-mode.js";
import { generateDiffString } from "./diff-utils.js";
import { createTypeboxTool } from "./typebox-tool.js";
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

const writeSchema = Type.Object({
	path: Type.String({
		description: "Path to the file to write (relative or absolute)",
		minLength: 1,
	}),
	content: Type.String({
		description: "Content to write to the file",
		default: "",
	}),
	previewDiff: Type.Boolean({
		description:
			"If true, return the diff between previous content and new content (when file exists)",
		default: true,
	}),
	backup: Type.Boolean({
		description:
			"If true, writes a .bak copy alongside the file before overwriting",
		default: true,
	}),
});

export const writeTool = createTypeboxTool({
	name: "write",
	label: "write",
	description:
		"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
	schema: writeSchema,
	async execute(_toolCallId, { path, content, previewDiff, backup }, signal) {
		const absolutePath = resolvePath(expandPath(path));
		requirePlanCheck("write");
		const dir = dirname(absolutePath);

		return new Promise<{
			content: Array<{ type: "text"; text: string }>;
			details:
				| undefined
				| {
						previousExists: boolean;
						bytesWritten: number;
						diff?: string;
						backupPath?: string;
						validators?: ValidatorRunResult[];
				  };
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

					let previousContent: string | null = null;
					let backupPath: string | undefined;
					let previousExists = false;

					try {
						await access(absolutePath, constants.R_OK);
						previousContent = await readFile(absolutePath, "utf-8");
						previousExists = true;
					} catch {
						previousExists = false;
					}

					if (aborted) {
						return;
					}

					let movedToBackup = false;
					if (previousExists && backup && previousContent !== null) {
						backupPath = `${absolutePath}.bak`;
						try {
							await rename(absolutePath, backupPath);
							movedToBackup = true;
						} catch {
							await writeFile(backupPath, previousContent, "utf-8");
						}
					}

					if (aborted) {
						return;
					}

					try {
						await writeFile(absolutePath, content, "utf-8");
					} catch (error) {
						if (movedToBackup && backupPath) {
							try {
								await rename(backupPath, absolutePath);
							} catch {
								// Best-effort restore; ignore restore errors
							}
						}
						throw error;
					}

					if (aborted) {
						return;
					}

					if (signal) {
						signal.removeEventListener("abort", onAbort);
					}

					const diff =
						previousContent !== null && previewDiff
							? generateDiffString(previousContent, content)
							: undefined;

					let validatorSummaries: ValidatorRunResult[] | undefined;
					try {
						const lspDiagnostics = await collectDiagnostics();
						validatorSummaries = await runValidatorsOnSuccess(
							[absolutePath],
							lspDiagnostics,
						);
					} catch (validatorError) {
						if (movedToBackup && backupPath) {
							await rename(backupPath, absolutePath);
						} else if (!previousExists) {
							await rm(absolutePath, { force: true });
						} else if (previousContent !== null) {
							await writeFile(absolutePath, previousContent, "utf-8");
						}
						throw validatorError;
					}

					const summaryLines: string[] = [];
					summaryLines.push(
						`Successfully wrote ${content.length} bytes to ${path}`,
					);
					if (previousExists) {
						summaryLines.push("Previous content was overwritten.");
						if (backupPath) {
							summaryLines.push(`Backup saved to ${backupPath}`);
						}
						if (diff) {
							summaryLines.push("Diff preview available in tool details.");
						}
					} else {
						summaryLines.push("File did not exist; it was created.");
					}

					resolve({
						content: [
							{
								type: "text",
								text: summaryLines.join("\n"),
							},
						],
						details: {
							previousExists,
							bytesWritten: Buffer.byteLength(content, "utf-8"),
							diff,
							backupPath,
							validators: validatorSummaries,
						},
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
