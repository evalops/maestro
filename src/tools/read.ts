import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { extname, resolve as resolvePath } from "node:path";
import { Type } from "@sinclair/typebox";
import { getLspConfig } from "../config/lsp-config.js";
import { getDiagnostics } from "../lsp/index.js";
import { createTool, expandUserPath } from "./tool-dsl.js";

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
	withDiagnostics: Type.Optional(
		Type.Boolean({
			description: "Include LSP diagnostics (errors/warnings) if available",
			default: true,
		}),
	),
	language: Type.Optional(
		Type.String({
			description:
				"Language identifier for the code fence (overrides auto-detection)",
		}),
	),
	encoding: Type.Optional(
		Type.Union(
			[
				Type.Literal("utf-8"),
				Type.Literal("utf-16le"),
				Type.Literal("latin1"),
				Type.Literal("ascii"),
			],
			{
				description:
					"Text encoding for the file (default: utf-8). Use latin1 for legacy files.",
				default: "utf-8",
			},
		),
	),
});

const MAX_LINES = 2000;
const MAX_LINE_LENGTH = 2000;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB - warn for very large files
const LARGE_FILE_THRESHOLD = 1 * 1024 * 1024; // 1MB - suggest pagination

type ReadToolDetails = {
	startLine?: number;
	endLine?: number;
	totalLines?: number;
	mode?: string;
};

export const readTool = createTool<
	typeof readSchema,
	ReadToolDetails | undefined
>({
	name: "read",
	label: "read",
	description: `Read file contents. Supports text and images (JPEG, PNG, GIF, WebP).

Parameters:
- path: File path (relative/absolute, supports ~/)
- offset: Start line (1-indexed)
- limit: Max lines
- mode: "normal", "head", "tail"
- encoding: utf-8 (default), utf-16le, latin1, ascii

Auto-detects images, provides syntax highlighting, handles large files.
Use 'batch' to read multiple files in parallel.`,
	schema: readSchema,
	async run(
		{
			path,
			offset,
			limit,
			mode = "normal",
			lineNumbers = true,
			wrapInCodeFence = true,
			asBase64 = false,
			withDiagnostics = true,
			language,
			encoding = "utf-8",
		},
		{ signal, respond, sandbox },
	) {
		const throwIfAborted = () => {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}
		};

		// Use sandbox if available
		if (sandbox) {
			try {
				const content = await sandbox.readFile(path);
				const lines = content.split("\n");
				const lang = language || guessLanguage(path);
				const formatted = wrapInCodeFence
					? `\`\`\`${lang || ""}\n${content}\n\`\`\``
					: content;
				return respond.text(formatted).detail({
					totalLines: lines.length,
					mode: "sandbox",
				});
			} catch (err) {
				return respond.error(`File not found in sandbox: ${path}`);
			}
		}

		const absolutePath = resolvePath(expandUserPath(path));
		const mimeType = isImageFile(absolutePath);

		try {
			await access(absolutePath, constants.R_OK);
		} catch {
			// Provide helpful hints for common path issues
			let hint = "";
			if (path.includes("//")) {
				hint = " (path contains double slashes - possible typo)";
			} else if (path.startsWith("./") && path.includes(" ")) {
				hint = " (path contains spaces - ensure it's correct)";
			} else if (!path.includes("/") && !path.includes(".")) {
				hint = " (no extension - did you forget the file extension?)";
			}
			return respond.error(`File not found: ${path}${hint}`);
		}

		throwIfAborted();

		// Check file size and provide appropriate feedback for large files
		const fileStats = await stat(absolutePath);
		const fileSizeBytes = fileStats.size;
		const fileSizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(2);

		if (fileSizeBytes > MAX_FILE_SIZE && !mimeType) {
			return respond.error(
				`File is too large (${fileSizeMB}MB). Maximum size is 10MB.\nFor large files, use:\n  - read("${path}", offset=1, limit=1000) to read specific sections\n  - bash("head -n 100 '${path}'") for first 100 lines\n  - bash("tail -n 100 '${path}'") for last 100 lines`,
			);
		}

		if (mimeType) {
			const buffer = await readFile(absolutePath);
			throwIfAborted();
			const base64 = buffer.toString("base64");
			return respond
				.text(`Read image file [${mimeType}]`)
				.image(base64, mimeType)
				.detail({ mode: "image" });
		}

		// Warn about large text files if not using pagination
		let largeFileWarning = "";
		if (fileSizeBytes > LARGE_FILE_THRESHOLD && !offset && !limit) {
			largeFileWarning = `\n\n📊 Note: This file is ${fileSizeMB}MB. Only showing first ${MAX_LINES} lines. Use offset/limit parameters for pagination.`;
		}

		const rawBuffer = await readFile(absolutePath);
		throwIfAborted();
		const probablyBinary = isProbablyBinary(rawBuffer);

		if (probablyBinary && !asBase64) {
			return respond
				.text(
					"Binary file detected. Re-run with asBase64=true or use the bash tool for inspection.",
				)
				.detail({ mode: "binary" });
		}

		if (probablyBinary && asBase64) {
			const base64 = rawBuffer.toString("base64");
			return respond
				.text(`Read binary file (${base64.length} base64 chars)`)
				.text(base64)
				.detail({ mode: "binary-base64" });
		}

		const textContent = rawBuffer.toString(encoding);
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
			return respond
				.error(
					`Offset ${offset} is beyond end of file (${lines.length} lines total)`,
				)
				.detail({ mode, totalLines: lines.length });
		}

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
			const lineNumber = String(startLine + index + 1).padStart(width, " ");
			return `${lineNumber} | ${displayLine}`;
		});

		const fenceLanguage = language ?? guessLanguage(absolutePath) ?? "";
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
			notices.push(`Showing last ${selectedLines.length} line(s)`);
		}
		if (mode === "head") {
			notices.push(`Showing first ${selectedLines.length} line(s)`);
		}
		if (notices.length > 0) {
			formattedText += `\n\n... (${notices.join(". ")})`;
		}

		// Add large file warning if applicable
		if (largeFileWarning) {
			formattedText += largeFileWarning;
		}

		// Append LSP diagnostics if available
		if (withDiagnostics) {
			try {
				const diagnostics = await getDiagnostics(absolutePath);
				if (diagnostics.length > 0) {
					// Treat undefined severity as error (severity 1) per LSP spec
					const errors = diagnostics.filter(
						(d) => d.severity === 1 || d.severity === undefined,
					);
					const warnings = diagnostics.filter((d) => d.severity === 2);

					if (errors.length > 0 || warnings.length > 0) {
						formattedText += "\n\n--- LSP Diagnostics ---\n";

						const config = getLspConfig();
						const maxDiagnostics = config.maxDiagnosticsPerFile ?? 10;
						let count = 0;

						// Sanitize and limit message length to prevent injection and overflow
						const sanitizeMessage = (msg: string): string => {
							// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally removing control chars for security
							const controlChars = /[\x00-\x1F\x7F]/g;
							return msg
								.replace(/[`\n\r]/g, " ") // Remove backticks and newlines
								.replace(controlChars, "") // Remove control characters
								.slice(0, 500); // Limit length
						};

						for (const d of errors) {
							if (count >= maxDiagnostics) break;
							const message = sanitizeMessage(d.message);
							formattedText += `ERROR (line ${d.range.start.line + 1}): ${message}\n`;
							count++;
						}

						for (const d of warnings) {
							if (count >= maxDiagnostics) break;
							const message = sanitizeMessage(d.message);
							formattedText += `WARN (line ${d.range.start.line + 1}): ${message}\n`;
							count++;
						}

						if (errors.length + warnings.length > maxDiagnostics) {
							const remaining =
								errors.length + warnings.length - maxDiagnostics;
							formattedText += `...and ${remaining} more ${remaining === 1 ? "diagnostic" : "diagnostics"} hidden.\n`;
						}
					}
				}
			} catch (error) {
				// Ignore LSP errors during read, but log for debug
				console.debug("[read] Failed to get LSP diagnostics:", error);
			}
		}

		return respond.text(formattedText).detail({
			mode,
			startLine: startLine + 1,
			endLine,
			totalLines: lines.length,
		});
	},
});
