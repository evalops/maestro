import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import * as os from "node:os";
import { extname, resolve as resolvePath } from "node:path";
import { Type } from "@sinclair/typebox";
import type { AgentTool, ImageContent, TextContent } from "../agent/types.js";
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

/**
 * Map of file extensions to MIME types for common image formats
 */
const IMAGE_MIME_TYPES: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
};

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
	".ts": "ts",
	".tsx": "tsx",
	".js": "javascript",
	".jsx": "jsx",
	".json": "json",
	".py": "python",
	".rb": "ruby",
	".go": "go",
	".java": "java",
	".rs": "rust",
	".c": "c",
	".cpp": "cpp",
	".h": "c",
	".sh": "bash",
	".md": "markdown",
	".yml": "yaml",
	".yaml": "yaml",
	".sql": "sql",
};

/**
 * Check if a file is an image based on its extension
 */
function isImageFile(filePath: string): string | null {
	const ext = extname(filePath).toLowerCase();
	return IMAGE_MIME_TYPES[ext] || null;
}

function guessLanguage(filePath: string): string | undefined {
	const ext = extname(filePath).toLowerCase();
	return LANGUAGE_BY_EXTENSION[ext];
}

function isProbablyBinary(buffer: Buffer): boolean {
	const sample = buffer.subarray(0, 2048);
	for (const byte of sample) {
		if (byte === 0) {
			return true;
		}
	}
	return false;
}

const readSchema = Type.Object({
	path: Type.String({
		description: "Path to the file to read (relative or absolute)",
		minLength: 1,
	}),
	offset: Type.Optional(
		Type.Integer({
			description: "Line number to start reading from (1-indexed)",
			minimum: 1,
		}),
	),
	limit: Type.Optional(
		Type.Integer({
			description: "Maximum number of lines to read",
			minimum: 1,
		}),
	),
	mode: Type.Optional(
		Type.Union(
			[Type.Literal("normal"), Type.Literal("head"), Type.Literal("tail")],
			{
				description: "Reading mode: normal offset/limit, head, or tail",
				default: "normal",
			},
		),
	),
	lineNumbers: Type.Optional(
		Type.Boolean({
			description: "Prefix output lines with line numbers",
			default: true,
		}),
	),
	wrapInCodeFence: Type.Optional(
		Type.Boolean({
			description: "Wrap text output in a Markdown code fence",
			default: true,
		}),
	),
	asBase64: Type.Optional(
		Type.Boolean({
			description: "Return binary files as base64 instead of text",
			default: false,
		}),
	),
	language: Type.Optional(
		Type.String({
			description:
				"Language identifier for the code fence (overrides auto-detection)",
		}),
	),
});

const MAX_LINES = 2000;
const MAX_LINE_LENGTH = 2000;

type ReadToolDetails = {
	startLine?: number;
	endLine?: number;
	totalLines?: number;
	mode?: string;
};

export const readTool: AgentTool<any, ReadToolDetails | undefined> =
	createTypeboxTool<typeof readSchema, ReadToolDetails | undefined>({
		name: "read",
		label: "read",
		description:
			"Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, defaults to first 2000 lines. Use offset/limit for large files.",
		schema: readSchema,
		async execute(
			_toolCallId,
			{
				path,
				offset,
				limit,
				mode = "normal",
				lineNumbers = true,
				wrapInCodeFence = true,
				asBase64 = false,
				language,
			},
			signal,
		) {
			const absolutePath = resolvePath(expandPath(path));
			const mimeType = isImageFile(absolutePath);

			return new Promise<{
				content: (TextContent | ImageContent)[];
				details: ReadToolDetails | undefined;
			}>((resolve, reject) => {
				// Check if already aborted
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}

				let aborted = false;

				// Set up abort handler
				const onAbort = () => {
					aborted = true;
					reject(new Error("Operation aborted"));
				};

				if (signal) {
					signal.addEventListener("abort", onAbort, { once: true });
				}

				// Perform the read operation
				(async () => {
					try {
						// Check if file exists
						try {
							await access(absolutePath, constants.R_OK);
						} catch {
							if (signal) {
								signal.removeEventListener("abort", onAbort);
							}
							resolve({
								content: [
									{ type: "text", text: `Error: File not found: ${path}` },
								],
								details: undefined,
							});
							return;
						}

						// Check if aborted before reading
						if (aborted) {
							return;
						}

						// Read the file based on type
						let content: (TextContent | ImageContent)[];

						let readDetails: ReadToolDetails | undefined;

						if (mimeType) {
							const buffer = await readFile(absolutePath);
							const base64 = buffer.toString("base64");
							content = [
								{ type: "text", text: `Read image file [${mimeType}]` },
								{ type: "image", data: base64, mimeType },
							];
							readDetails = { mode: "image" };
						} else {
							const rawBuffer = await readFile(absolutePath);
							const probablyBinary = isProbablyBinary(rawBuffer);

							if (probablyBinary && !asBase64) {
								content = [
									{
										type: "text",
										text: "Binary file detected. Re-run with asBase64=true or use the bash tool for inspection.",
									},
								];
								readDetails = { mode: "binary" };
							} else if (probablyBinary && asBase64) {
								const base64 = rawBuffer.toString("base64");
								content = [
									{
										type: "text",
										text: `Read binary file (${base64.length} base64 chars)`,
									},
									{ type: "text", text: base64 },
								];
								readDetails = { mode: "binary-base64" };
							} else {
								const textContent = rawBuffer.toString("utf-8");
								const lines = textContent.split("\n");
								let startLine = offset ? Math.max(0, offset - 1) : 0;
								let maxLines = limit || MAX_LINES;

								switch (mode) {
									case "head":
										startLine = 0;
										maxLines = limit || MAX_LINES;
										break;
									case "tail":
										maxLines = limit || MAX_LINES;
										startLine = Math.max(lines.length - maxLines, 0);
										break;
									default:
										break;
								}

								if (startLine >= lines.length) {
									content = [
										{
											type: "text",
											text: `Error: Offset ${offset} is beyond end of file (${lines.length} lines total)`,
										},
									];
									readDetails = { mode, totalLines: lines.length };
								} else {
									const endLine = Math.min(startLine + maxLines, lines.length);
									const selectedLines = lines.slice(startLine, endLine);
									let hadTruncatedLines = false;
									const width = String(endLine).length;
									const numberedLines = selectedLines.map((line, index) => {
										let displayLine = line;
										if (line.length > MAX_LINE_LENGTH) {
											hadTruncatedLines = true;
											displayLine = line.slice(0, MAX_LINE_LENGTH);
										}
										if (!lineNumbers) {
											return displayLine;
										}
										const lineNumber = String(startLine + index + 1).padStart(
											width,
											" ",
										);
										return `${lineNumber} | ${displayLine}`;
									});

									const fenceLanguage =
										language ?? guessLanguage(absolutePath) ?? "";
									let formattedText = numberedLines.join("\n");
									if (wrapInCodeFence) {
										formattedText = `\`\`\`${fenceLanguage}\n${formattedText}\n\`\`\``;
									}

									const notices: string[] = [];
									if (hadTruncatedLines) {
										notices.push(
											`Some lines were truncated to ${MAX_LINE_LENGTH} characters for display`,
										);
									}
									if (startLine > 0) {
										notices.push(`${startLine} earlier lines not shown`);
									}
									if (endLine < lines.length) {
										notices.push(
											`${lines.length - endLine} later lines not shown. Use offset=${endLine + 1} to continue reading`,
										);
									}
									if (mode === "tail") {
										notices.push(
											`Showing last ${selectedLines.length} line(s)`,
										);
									}
									if (mode === "head") {
										notices.push(
											`Showing first ${selectedLines.length} line(s)`,
										);
									}
									if (notices.length > 0) {
										formattedText += `\n\n... (${notices.join(". ")})`;
									}

									content = [{ type: "text", text: formattedText }];
									readDetails = {
										mode,
										startLine: startLine + 1,
										endLine,
										totalLines: lines.length,
									};
								}
							}
						}

						// Check if aborted after reading
						if (aborted) {
							return;
						}

						// Clean up abort handler
						if (signal) {
							signal.removeEventListener("abort", onAbort);
						}

						resolve({ content, details: readDetails });
					} catch (error: unknown) {
						// Clean up abort handler
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
