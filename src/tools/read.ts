/**
 * Read Tool - File reading capabilities for the agent.
 *
 * This module provides comprehensive file reading functionality supporting:
 * - Text files with line numbers, syntax highlighting, and pagination
 * - Images (JPEG, PNG, GIF, WebP) with optional Sharp optimization
 * - PDF documents (requires pdf-parse package)
 * - Jupyter notebooks (.ipynb) with cell formatting
 * - Binary files with base64 encoding option
 *
 * ## Key Features
 *
 * - **Pagination**: Large files can be read in chunks using offset/limit
 * - **Line Numbers**: Output includes line numbers for easy reference
 * - **Code Fencing**: Text wrapped in markdown code blocks with language hints
 * - **LSP Integration**: Optionally includes diagnostics (errors/warnings)
 * - **Image Optimization**: Uses Sharp (when available) to resize large images
 * - **Binary Detection**: Automatically detects and handles binary files
 *
 * ## Safety Limits
 *
 * - Max 2000 lines per read (use pagination for larger files)
 * - Max 2000 characters per line (truncated with warning)
 * - Max 10MB file size (with error for text, allowed for images)
 * - Large file warnings at 1MB threshold
 */

import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { extname, resolve as resolvePath } from "node:path";
import { Type } from "@sinclair/typebox";
import { getLspConfig } from "../config/lsp-config.js";
import { getDiagnostics } from "../lsp/index.js";
import { isProbablyBinary } from "../utils/file-content.js";
import {
	isSharpAvailable,
	isSupportedImageFormat,
	processImageForClaude,
} from "./image-processor.js";
import { formatNotebookForDisplay, isNotebookFile } from "./notebook.js";
import { createTool, expandUserPath } from "./tool-dsl.js";

/**
 * MIME type mapping for supported image formats.
 * Used to determine if a file is an image and set proper content type.
 */
const IMAGE_MIME_TYPES: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
};

/**
 * Check if a file is a PDF based on extension.
 */
function isPdfFile(filePath: string): boolean {
	return extname(filePath).toLowerCase() === ".pdf";
}

/**
 * Result structure from pdf-parse library.
 */
type PdfParseResult = {
	text: string;
	numpages: number;
	info: Record<string, unknown>;
};

type PdfParseFunction = (buffer: Buffer) => Promise<PdfParseResult>;

// Lazy-loaded pdf-parse module (undefined = not yet loaded, null = not available)
let pdfParse: PdfParseFunction | null | undefined = undefined;

function resolvePdfParseModule(mod: unknown): PdfParseFunction | null {
	if (typeof mod === "function") {
		return mod as PdfParseFunction;
	}
	if (mod && typeof mod === "object") {
		const maybeDefault = (mod as { default?: unknown }).default;
		if (typeof maybeDefault === "function") {
			return maybeDefault as PdfParseFunction;
		}
	}
	return null;
}

/**
 * Lazily load the pdf-parse library.
 *
 * This function implements lazy loading to:
 * 1. Avoid startup overhead when PDF reading isn't needed
 * 2. Allow the tool to function without pdf-parse installed
 * 3. Handle ESM/CJS interoperability
 *
 * @returns The pdf-parse function, or null if not available
 */
async function getPdfParser(): Promise<PdfParseFunction | null> {
	if (pdfParse === undefined) {
		try {
			const module = (await import("pdf-parse")) as unknown;
			pdfParse = resolvePdfParseModule(module);
		} catch {
			// pdf-parse not installed - mark as unavailable
			pdfParse = null;
		}
	}
	return pdfParse;
}

/**
 * Language identifiers for code fence syntax highlighting.
 * Maps file extensions to markdown code fence language hints.
 */
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
 * Check if a file is an image based on extension.
 *
 * @param filePath - Path to check
 * @returns MIME type string if image, null otherwise
 */
function isImageFile(filePath: string): string | null {
	const ext = extname(filePath).toLowerCase();
	return IMAGE_MIME_TYPES[ext] || null;
}

/**
 * Guess the programming language from file extension.
 *
 * Used to provide syntax highlighting hints in code fences.
 *
 * @param filePath - Path to analyze
 * @returns Language identifier for code fence, or undefined
 */
function guessLanguage(filePath: string): string | undefined {
	const ext = extname(filePath).toLowerCase();
	return LANGUAGE_BY_EXTENSION[ext];
}

/**
 * Schema for read tool parameters.
 * Defines all options for customizing file reading behavior.
 */
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

// =============================================================================
// Safety Limits
// =============================================================================

// Maximum lines to return in a single read (prevents memory exhaustion)
const MAX_LINES = 2000;

// Maximum characters per line (prevents extremely long lines from causing issues)
const MAX_LINE_LENGTH = 2000;

// Hard limit for file size - files larger than this cannot be read as text
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// Threshold for "large file" warning - suggests pagination for files this size
const LARGE_FILE_THRESHOLD = 1 * 1024 * 1024; // 1MB

/**
 * Details returned from the read tool for context and debugging.
 * Includes pagination info, image processing details, etc.
 */
type ReadToolDetails = {
	/** First line number returned (1-indexed) */
	startLine?: number;
	/** Last line number returned */
	endLine?: number;
	/** Total lines in the file */
	totalLines?: number;
	/** Reading mode used */
	mode?: string;
	// Image processing details (when reading images with Sharp)
	originalWidth?: number;
	originalHeight?: number;
	width?: number;
	height?: number;
	wasOptimized?: boolean;
};

/**
 * The read tool instance created using the tool DSL.
 *
 * This tool handles multiple file types with specialized processing:
 * 1. Images → Base64 encoded with optional Sharp optimization
 * 2. PDFs → Text extraction via pdf-parse
 * 3. Notebooks → Cell-by-cell formatted display
 * 4. Binary → Detection with base64 option
 * 5. Text → Line-numbered, syntax-highlighted output
 */
export const readTool = createTool<
	typeof readSchema,
	ReadToolDetails | undefined
>({
	name: "read",
	label: "read",
	description: `Read file contents. Supports text, images (JPEG, PNG, GIF, WebP), PDFs, and Jupyter notebooks (.ipynb).

Parameters:
- path: File path (relative/absolute, supports ~/)
- offset: Start line (1-indexed)
- limit: Max lines
- mode: "normal", "head", "tail"
- encoding: utf-8 (default), utf-16le, latin1, ascii

Auto-detects images, PDFs, and notebooks. Provides syntax highlighting and handles large files.
Emit multiple read tool calls in one turn when you need parallel reads; the runtime will execute them concurrently—no batch wrapper required.`,
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
		// Helper to check for operation cancellation
		const throwIfAborted = () => {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}
		};

		// ============================================
		// Sandbox Mode - Use isolated environment if available
		// ============================================
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

		// ============================================
		// Path Resolution and Access Check
		// ============================================
		// Resolve path (expand ~, handle relative paths)
		const absolutePath = resolvePath(expandUserPath(path));
		const mimeType = isImageFile(absolutePath);

		// Verify file exists and is readable
		try {
			await access(absolutePath, constants.R_OK);
		} catch {
			// Provide helpful hints for common path mistakes
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

		// ============================================
		// File Size Validation
		// ============================================
		const fileStats = await stat(absolutePath);
		const fileSizeBytes = fileStats.size;
		const fileSizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(2);

		// Reject oversized text files (images are allowed to be larger)
		if (fileSizeBytes > MAX_FILE_SIZE && !mimeType) {
			return respond.error(
				`File is too large (${fileSizeMB}MB). Maximum size is 10MB.\nFor large files, use:\n  - read("${path}", offset=1, limit=1000) to read specific sections\n  - bash("head -n 100 '${path}'") for first 100 lines\n  - bash("tail -n 100 '${path}'") for last 100 lines`,
			);
		}

		// ============================================
		// Image File Handling
		// ============================================
		if (mimeType || isSupportedImageFormat(absolutePath)) {
			const buffer = await readFile(absolutePath);
			throwIfAborted();

			// Try to optimize image with Sharp if available
			// Sharp can resize large images to reduce token usage
			const sharpAvailable = await isSharpAvailable();
			if (sharpAvailable && isSupportedImageFormat(absolutePath)) {
				try {
					const processed = await processImageForClaude(buffer);
					const sizeInfo =
						processed.wasResized || processed.wasCompressed
							? ` (optimized: ${Math.round(processed.processedSize / 1024)}KB)`
							: "";
					return respond
						.text(`Read image file [${processed.mimeType}]${sizeInfo}`)
						.image(processed.base64, processed.mimeType)
						.detail({
							mode: "image",
							originalWidth: processed.originalWidth,
							originalHeight: processed.originalHeight,
							width: processed.width,
							height: processed.height,
							wasOptimized: processed.wasResized || processed.wasCompressed,
						});
				} catch {
					// Fall back to unprocessed image if Sharp fails
				}
			}

			// Fallback: return unprocessed image as base64
			const base64 = buffer.toString("base64");
			const detectedMime = mimeType || "image/png";
			return respond
				.text(`Read image file [${detectedMime}]`)
				.image(base64, detectedMime)
				.detail({ mode: "image" });
		}

		// ============================================
		// Jupyter Notebook Handling
		// ============================================
		if (isNotebookFile(absolutePath)) {
			const content = await readFile(absolutePath, "utf-8");
			throwIfAborted();
			// Format notebook cells for readable display
			const formatted = formatNotebookForDisplay(content);
			const lines = formatted.split("\n");
			return respond
				.text(`\`\`\`python\n${formatted}\n\`\`\``)
				.detail({ mode: "notebook", totalLines: lines.length });
		}

		// ============================================
		// PDF File Handling
		// ============================================
		if (isPdfFile(absolutePath)) {
			// Lazy-load PDF parser
			const parser = await getPdfParser();
			if (!parser) {
				return respond.error(
					"PDF reading requires the 'pdf-parse' package. Install with: npm install pdf-parse",
				);
			}
			const buffer = await readFile(absolutePath);
			throwIfAborted();
			try {
				const data = await parser(buffer);
				const text = data.text.trim();
				const lines = text.split("\n");
				const pageInfo = `PDF Document: ${data.numpages} page(s)`;

				// Apply pagination if requested
				let displayText = text;
				const startLine = offset ? Math.max(0, offset - 1) : 0;
				const maxLines = limit || MAX_LINES;

				if (offset || limit) {
					const selectedLines = lines.slice(startLine, startLine + maxLines);
					displayText = selectedLines.join("\n");
				} else if (lines.length > MAX_LINES) {
					// Auto-truncate very long PDFs
					displayText = lines.slice(0, MAX_LINES).join("\n");
				}

				return respond.text(`${pageInfo}\n\n${displayText}`).detail({
					mode: "pdf",
					totalLines: lines.length,
					startLine: startLine + 1,
					endLine: Math.min(startLine + maxLines, lines.length),
				});
			} catch (err) {
				return respond.error(
					`Failed to parse PDF: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		// ============================================
		// Text File Handling (default path)
		// ============================================

		// Prepare large file warning for display
		let largeFileWarning = "";
		if (fileSizeBytes > LARGE_FILE_THRESHOLD && !offset && !limit) {
			largeFileWarning = `\n\n📊 Note: This file is ${fileSizeMB}MB. Only showing first ${MAX_LINES} lines. Use offset/limit parameters for pagination.`;
		}

		// Read raw file content
		const rawBuffer = await readFile(absolutePath);
		throwIfAborted();

		// Check for binary content
		const probablyBinary = isProbablyBinary(rawBuffer);

		if (probablyBinary && !asBase64) {
			// Binary file without base64 flag - prompt user for explicit handling
			return respond
				.text(
					"Binary file detected. Re-run with asBase64=true or use the bash tool for inspection.",
				)
				.detail({ mode: "binary" });
		}

		if (probablyBinary && asBase64) {
			// Binary file with base64 flag - return encoded content
			const base64 = rawBuffer.toString("base64");
			return respond
				.text(`Read binary file (${base64.length} base64 chars)`)
				.text(base64)
				.detail({ mode: "binary-base64" });
		}

		// ============================================
		// Text Processing and Pagination
		// ============================================

		// Decode text content with specified encoding
		const textContent = rawBuffer.toString(encoding);
		const lines = textContent.split("\n");

		// Calculate line range based on mode and parameters
		let startLine = offset ? Math.max(0, offset - 1) : 0;
		let maxLines = limit || MAX_LINES;

		switch (mode) {
			case "head":
				// Read from beginning
				startLine = 0;
				maxLines = limit || MAX_LINES;
				break;
			case "tail":
				// Read from end
				maxLines = limit || MAX_LINES;
				startLine = Math.max(lines.length - maxLines, 0);
				break;
			default:
				// Normal mode - use offset/limit as provided
				break;
		}

		// Validate offset is within file bounds
		if (startLine >= lines.length) {
			return respond
				.error(
					`Offset ${offset} is beyond end of file (${lines.length} lines total)`,
				)
				.detail({ mode, totalLines: lines.length });
		}

		// Extract the requested line range
		const endLine = Math.min(startLine + maxLines, lines.length);
		const selectedLines = lines.slice(startLine, endLine);

		// Format lines with optional line numbers
		let hadTruncatedLines = false;
		const width = String(endLine).length; // Padding width for line numbers
		const numberedLines = selectedLines.map((line, index) => {
			let displayLine = line;
			// Truncate extremely long lines
			if (line.length > MAX_LINE_LENGTH) {
				hadTruncatedLines = true;
				displayLine = line.slice(0, MAX_LINE_LENGTH);
			}
			if (!lineNumbers) {
				return displayLine;
			}
			// Format: "  42 | code here"
			const lineNumber = String(startLine + index + 1).padStart(width, " ");
			return `${lineNumber} | ${displayLine}`;
		});

		// ============================================
		// Output Formatting
		// ============================================

		// Determine language for syntax highlighting
		const fenceLanguage = language ?? guessLanguage(absolutePath) ?? "";
		let formattedText = numberedLines.join("\n");
		if (wrapInCodeFence) {
			formattedText = `\`\`\`${fenceLanguage}\n${formattedText}\n\`\`\``;
		}

		// Build helpful notices about what's shown
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

		// Append large file warning if applicable
		if (largeFileWarning) {
			formattedText += largeFileWarning;
		}

		// ============================================
		// LSP Diagnostics (optional)
		// ============================================
		// Fetch and append errors/warnings from the Language Server if available
		if (withDiagnostics) {
			try {
				const diagnostics = await getDiagnostics(absolutePath);
				if (diagnostics.length > 0) {
					// Categorize by severity (1 = error, 2 = warning per LSP spec)
					// Treat undefined severity as error for safety
					const errors = diagnostics.filter(
						(d) => d.severity === 1 || d.severity === undefined,
					);
					const warnings = diagnostics.filter((d) => d.severity === 2);

					if (errors.length > 0 || warnings.length > 0) {
						formattedText += "\n\n--- LSP Diagnostics ---\n";

						const config = getLspConfig();
						const maxDiagnostics = config.maxDiagnosticsPerFile ?? 10;
						let count = 0;

						// Sanitize diagnostic messages to prevent:
						// - Markdown injection (backticks)
						// - Control character exploits
						// - Overly long messages consuming context
						const sanitizeMessage = (msg: string): string => {
							const stripped = msg.replace(/[`\n\r]/g, " ");
							let sanitized = "";
							for (const char of stripped) {
								const code = char.charCodeAt(0);
								const isControl = code <= 0x1f || code === 0x7f;
								if (!isControl) {
									sanitized += char;
								}
							}
							return sanitized.slice(0, 500); // Limit length
						};

						// Output errors first (higher priority)
						for (const d of errors) {
							if (count >= maxDiagnostics) break;
							const message = sanitizeMessage(d.message);
							formattedText += `ERROR (line ${d.range.start.line + 1}): ${message}\n`;
							count++;
						}

						// Then warnings
						for (const d of warnings) {
							if (count >= maxDiagnostics) break;
							const message = sanitizeMessage(d.message);
							formattedText += `WARN (line ${d.range.start.line + 1}): ${message}\n`;
							count++;
						}

						// Indicate if more diagnostics were hidden
						if (errors.length + warnings.length > maxDiagnostics) {
							const remaining =
								errors.length + warnings.length - maxDiagnostics;
							formattedText += `...and ${remaining} more ${remaining === 1 ? "diagnostic" : "diagnostics"} hidden.\n`;
						}
					}
				}
			} catch (error) {
				// LSP errors are non-fatal - file read still succeeds
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
