/**
 * Write Tool - Safe File Writing with Validation
 *
 * This module provides a file writing tool with built-in safety features
 * including backup creation, LSP diagnostics, validator integration, and
 * sandbox support. It creates parent directories automatically.
 *
 * ## Safety Features
 *
 * - **Backup creation**: Automatically creates .bak files before overwriting
 * - **Plan checking**: Requires plan approval in safe mode
 * - **LSP integration**: Collects diagnostics after writing
 * - **Validator support**: Runs configured validators on written files
 * - **Rollback**: Restores original content if validators fail
 *
 * ## Write Flow
 *
 * ```
 * ┌─────────────────────────────────────────────────────────────┐
 * │                     Write Operation Flow                    │
 * ├─────────────────────────────────────────────────────────────┤
 * │  1. Check plan approval (safe mode)                         │
 * │  2. Create parent directories                               │
 * │  3. Read existing content (if any)                          │
 * │  4. Create backup (.bak file)                               │
 * │  5. Write new content                                       │
 * │  6. Collect LSP diagnostics                                 │
 * │  7. Run validators                                          │
 * │  8. If validators fail → restore backup                     │
 * │  9. Return success with diff preview                        │
 * └─────────────────────────────────────────────────────────────┘
 * ```
 *
 * ## Sandbox Mode
 *
 * When running in a sandbox environment, the tool uses the sandbox's
 * virtual filesystem instead of the real filesystem.
 *
 * ## Example
 *
 * ```typescript
 * // Write a new file
 * writeTool.execute('call-id', {
 *   path: 'src/utils/helper.ts',
 *   content: 'export function helper() { return 42; }',
 *   backup: true,
 *   previewDiff: true,
 * });
 * ```
 *
 * @module tools/write
 */

import { constants } from "node:fs";
import {
	access,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { Type } from "@sinclair/typebox";
import { collectDiagnostics } from "../lsp/index.js";
import {
	requirePlanCheck,
	runValidatorsOnSuccess,
} from "../safety/safe-mode.js";
import type { ValidatorRunResult } from "../safety/safe-mode.js";
import { formatLspDiagnostics, generateDiffString } from "./diff-utils.js";
import { createTool, expandUserPath } from "./tool-dsl.js";

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

type WriteToolDetails = {
	previousExists?: boolean;
	bytesWritten?: number;
	diff?: string;
	backupPath?: string;
	validators?: ValidatorRunResult[];
	mode?: "sandbox";
};

export const writeTool = createTool<typeof writeSchema, WriteToolDetails>({
	name: "write",
	label: "write",
	description:
		"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
	schema: writeSchema,
	async run(
		{ path, content, previewDiff = true, backup = true },
		{ signal, respond, sandbox },
	) {
		requirePlanCheck("write");

		// Use sandbox if available
		if (sandbox) {
			try {
				let previousContent: string | null = null;
				try {
					if (await sandbox.exists(path)) {
						previousContent = await sandbox.readFile(path);
					}
				} catch {
					// File doesn't exist
				}

				await sandbox.writeFile(path, content);

				const diff =
					previousContent !== null && previewDiff
						? generateDiffString(previousContent, content)
						: undefined;

				return respond
					.text(
						previousContent !== null
							? `Updated ${path} in sandbox`
							: `Created ${path} in sandbox`,
					)
					.detail({ diff, mode: "sandbox" });
			} catch (err) {
				return respond.error(
					`Failed to write file in sandbox: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		const absolutePath = resolvePath(expandUserPath(path));
		const dir = dirname(absolutePath);
		const ensureNotAborted = () => {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}
		};

		ensureNotAborted();
		await mkdir(dir, { recursive: true });
		ensureNotAborted();

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

		ensureNotAborted();

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

		ensureNotAborted();

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

		ensureNotAborted();

		const diff =
			previousContent !== null && previewDiff
				? generateDiffString(previousContent, content)
				: undefined;

		let validatorSummaries: ValidatorRunResult[] | undefined;
		let linterOutput = "";
		try {
			const lspDiagnostics = await collectDiagnostics();
			const fileDiagnostics = lspDiagnostics[absolutePath] || [];
			if (fileDiagnostics.length > 0) {
				linterOutput = formatLspDiagnostics(path, fileDiagnostics);
			}

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
		summaryLines.push(`Successfully wrote ${content.length} bytes to ${path}`);
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

		if (linterOutput) {
			summaryLines.push(linterOutput);
		}

		return respond.text(summaryLines.join("\n")).detail({
			previousExists,
			bytesWritten: Buffer.byteLength(content, "utf-8"),
			diff,
			backupPath,
			validators: validatorSummaries,
		});
	},
});
