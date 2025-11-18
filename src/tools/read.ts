import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { extname, resolve as resolvePath } from "node:path";
import { Type } from "@sinclair/typebox";
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
			language,
		},
		{ signal, respond },
	) {
		const throwIfAborted = () => {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}
		};

		const absolutePath = resolvePath(expandUserPath(path));
		const mimeType = isImageFile(absolutePath);

		try {
			await access(absolutePath, constants.R_OK);
		} catch {
			return respond.error(`File not found: ${path}`);
		}

		throwIfAborted();

		if (mimeType) {
			const buffer = await readFile(absolutePath);
			throwIfAborted();
			const base64 = buffer.toString("base64");
			return respond
				.text(`Read image file [${mimeType}]`)
				.image(base64, mimeType)
				.detail({ mode: "image" });
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
			return respond.error(
				`Offset ${offset} is beyond end of file (${lines.length} lines total)`,
				{ mode, totalLines: lines.length },
			);
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

		return respond.text(formattedText).detail({
			mode,
			startLine: startLine + 1,
			endLine,
			totalLines: lines.length,
		});
	},
});
