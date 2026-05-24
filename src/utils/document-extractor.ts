import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

export type ExtractedDocumentFormat =
	| "pdf"
	| "docx"
	| "xlsx"
	| "pptx"
	| "text"
	| "unknown";

export interface ExtractDocumentInput {
	buffer: Buffer;
	fileName: string;
	mimeType?: string;
	maxChars?: number;
}

export interface ExtractDocumentOutput {
	extractedText: string;
	format: ExtractedDocumentFormat;
	extractor: "native" | "markitdown";
	truncated: boolean;
	sizeBytes: number;
}

type ExcelWorkbookLoadInput = Parameters<ExcelJS.Workbook["xlsx"]["load"]>[0];

const DEFAULT_MAX_CHARS = 200_000;
const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MARKITDOWN_TIMEOUT_MS = 20_000;
const MARKITDOWN_TIMEOUT_KILL_GRACE_MS = 500;
const MARKITDOWN_TIMEOUT_CLOSE_GRACE_MS = 1_000;
const NODE_TIMER_MAX_MS = 2_147_483_647;
const XLSX_MIME =
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function clampText(
	text: string,
	maxChars: number,
): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	return { text: text.slice(0, maxChars), truncated: true };
}

function detectFormat(
	fileName: string,
	mimeType?: string,
): ExtractedDocumentFormat {
	const lowerName = fileName.toLowerCase();
	const type = (mimeType || "").toLowerCase();

	if (type === "application/pdf" || lowerName.endsWith(".pdf")) return "pdf";
	if (
		type ===
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
		lowerName.endsWith(".docx")
	)
		return "docx";
	if (type === XLSX_MIME || lowerName.endsWith(".xlsx")) return "xlsx";
	if (
		type ===
			"application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
		lowerName.endsWith(".pptx")
	)
		return "pptx";
	if (type.startsWith("text/")) return "text";

	const textExtensions = [
		".txt",
		".md",
		".markdown",
		".json",
		".yaml",
		".yml",
		".csv",
		".ts",
		".tsx",
		".js",
		".jsx",
		".html",
		".css",
		".xml",
	];
	if (textExtensions.some((ext) => lowerName.endsWith(ext))) return "text";

	return "unknown";
}

function splitCommandArgs(value: string | undefined): string[] {
	const input = value?.trim() ?? "";
	if (!input) return [];

	const args: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	let tokenStarted = false;

	for (let index = 0; index < input.length; index += 1) {
		const char = input.charAt(index);

		if (quote === "'") {
			if (char === "'") {
				quote = null;
			} else {
				current += char;
			}
			tokenStarted = true;
			continue;
		}

		if (quote === '"') {
			if (char === '"') {
				quote = null;
				tokenStarted = true;
				continue;
			}
			if (char === "\\") {
				const next = input[index + 1];
				if (next && ['"', "\\", "$", "`", "\n"].includes(next)) {
					current += next;
					index += 1;
				} else {
					current += char;
				}
				tokenStarted = true;
				continue;
			}
			current += char;
			tokenStarted = true;
			continue;
		}

		if (char === "\\") {
			const next = input[index + 1];
			if (next && (/\s/u.test(next) || ["'", '"', "\\"].includes(next))) {
				current += next;
				index += 1;
			} else {
				current += char;
			}
			tokenStarted = true;
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			tokenStarted = true;
			continue;
		}

		if (/\s/u.test(char)) {
			if (tokenStarted) {
				args.push(current);
				current = "";
				tokenStarted = false;
			}
			continue;
		}

		current += char;
		tokenStarted = true;
	}

	if (quote) {
		throw new Error("Unterminated quote in MAESTRO_MARKITDOWN_ARGS");
	}
	if (tokenStarted) {
		args.push(current);
	}
	return args;
}

function isMarkitdownDisabled(): boolean {
	return /^(0|false|off|no)$/i.test(process.env.MAESTRO_MARKITDOWN ?? "");
}

function markitdownCandidates(): Array<{
	command: string;
	argsPrefix: string[];
}> {
	const configured = process.env.MAESTRO_MARKITDOWN_CMD?.trim();
	if (configured) {
		return [
			{
				command: configured,
				argsPrefix: splitCommandArgs(process.env.MAESTRO_MARKITDOWN_ARGS),
			},
		];
	}
	return [
		{ command: "markitdown", argsPrefix: [] },
		{ command: "uvx", argsPrefix: ["markitdown"] },
	];
}

function shouldTryMarkitdown(
	format: ExtractedDocumentFormat,
	fileName: string,
	mimeType?: string,
): boolean {
	if (isMarkitdownDisabled()) return false;
	if (/^(1|true|on|yes)$/i.test(process.env.MAESTRO_MARKITDOWN_PREFER ?? "")) {
		return true;
	}
	const lowerName = fileName.toLowerCase();
	const type = (mimeType ?? "").toLowerCase();
	if (format === "unknown") return true;
	if (lowerName.endsWith(".html") || lowerName.endsWith(".htm")) return true;
	if (type.includes("text/html")) return true;
	return false;
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
	const value = process.env[name]?.trim();
	if (!value) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
		return fallback;
	}
	return Math.min(parsed, NODE_TIMER_MAX_MS);
}

function signalMarkitdownProcessTree(
	child: ReturnType<typeof spawn>,
	signal: NodeJS.Signals,
): void {
	if (process.platform !== "win32" && child.pid) {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") {
				return;
			}
		}
	}

	try {
		child.kill(signal);
	} catch {
		// The process may have exited between timeout handling and signal delivery.
	}
}

function runMarkitdownCandidate(
	candidate: { command: string; argsPrefix: string[] },
	args: string[],
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(candidate.command, [...candidate.argsPrefix, ...args], {
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		let killTimer: NodeJS.Timeout | undefined;
		let closeGraceTimer: NodeJS.Timeout | undefined;
		const timer = setTimeout(
			() => {
				timedOut = true;
				signalMarkitdownProcessTree(child, "SIGTERM");
				killTimer = setTimeout(
					() => {
						signalMarkitdownProcessTree(child, "SIGKILL");
						closeGraceTimer = setTimeout(
							() => {
								child.stdout.destroy();
								child.stderr.destroy();
								child.unref();
								finish(new Error("MarkItDown conversion timed out"));
							},
							readPositiveIntegerEnv(
								"MAESTRO_MARKITDOWN_CLOSE_GRACE_MS",
								MARKITDOWN_TIMEOUT_CLOSE_GRACE_MS,
							),
						);
					},
					readPositiveIntegerEnv(
						"MAESTRO_MARKITDOWN_KILL_GRACE_MS",
						MARKITDOWN_TIMEOUT_KILL_GRACE_MS,
					),
				);
			},
			readPositiveIntegerEnv(
				"MAESTRO_MARKITDOWN_TIMEOUT_MS",
				MARKITDOWN_TIMEOUT_MS,
			),
		);

		function finish(error: Error | null, output?: string) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			if (closeGraceTimer) clearTimeout(closeGraceTimer);
			if (error) {
				reject(error);
				return;
			}
			resolve(output ?? "");
		}

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			if (timedOut) {
				finish(new Error("MarkItDown conversion timed out"));
				return;
			}
			finish(error);
		});
		child.on("close", (code) => {
			if (timedOut) {
				finish(new Error("MarkItDown conversion timed out"));
				return;
			}
			if (code === 0) {
				finish(null, stdout);
				return;
			}
			finish(
				new Error(
					`MarkItDown exited with ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ""}`,
				),
			);
		});
	});
}

async function extractWithMarkitdown(input: {
	buffer: Buffer;
	fileName: string;
	mimeType?: string;
}): Promise<string | null> {
	const tempDir = await mkdtemp(join(tmpdir(), "maestro-markitdown-"));
	const extension = extname(input.fileName) || ".bin";
	const tempPath = join(tempDir, `input${extension}`);
	try {
		await writeFile(tempPath, input.buffer);
		const args = [tempPath];
		if (input.mimeType) {
			args.push("--mime-type", input.mimeType);
		}

		let lastError: unknown;
		for (const candidate of markitdownCandidates()) {
			try {
				const output = await runMarkitdownCandidate(candidate, args);
				const text = output.trim();
				if (text) return text;
			} catch (error) {
				lastError = error;
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			}
		}

		if (process.env.MAESTRO_MARKITDOWN_CMD) {
			const message =
				lastError instanceof Error ? lastError.message : String(lastError);
			throw new Error(`MarkItDown extraction failed: ${message}`);
		}
		return null;
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
}

function worksheetToRows(worksheet: ExcelJS.Worksheet): string[][] {
	const rows: string[][] = [];
	worksheet.eachRow({ includeEmpty: false }, (row) => {
		const cells: string[] = [];
		for (let column = 1; column <= row.cellCount; column++) {
			cells.push((row.getCell(column).text || "").trim());
		}
		while (cells.length > 0 && cells[cells.length - 1] === "") {
			cells.pop();
		}
		if (cells.some((value) => value !== "")) {
			rows.push(cells);
		}
	});
	return rows;
}

async function extractPptxText(buffer: Buffer): Promise<string> {
	const zip = await JSZip.loadAsync(buffer);

	const slidePaths = Object.keys(zip.files)
		.filter((p) => /^ppt\/slides\/slide\d+\.xml$/i.test(p))
		.sort((a, b) => {
			const an = Number.parseInt(a.match(/slide(\d+)\.xml/i)?.[1] || "0", 10);
			const bn = Number.parseInt(b.match(/slide(\d+)\.xml/i)?.[1] || "0", 10);
			return an - bn;
		});

	if (slidePaths.length === 0) {
		return "";
	}

	const parts: string[] = [];
	for (const slidePath of slidePaths) {
		const slideNumber = slidePath.match(/slide(\d+)\.xml/i)?.[1] || "?";
		const xml = await zip.file(slidePath)?.async("string");
		if (!xml) continue;

		const texts = Array.from(xml.matchAll(/<a:t>(.*?)<\/a:t>/g))
			.map((m) => m[1] || "")
			.map((s) =>
				s
					.replaceAll("&lt;", "<")
					.replaceAll("&gt;", ">")
					.replaceAll("&amp;", "&")
					.replaceAll("&quot;", '"')
					.replaceAll("&apos;", "'"),
			)
			.map((s) => s.trim())
			.filter(Boolean);

		if (texts.length === 0) continue;
		parts.push(`# Slide ${slideNumber}\n${texts.join(" ")}`);
	}

	return parts.join("\n\n");
}

export async function extractDocumentText(
	input: ExtractDocumentInput,
): Promise<ExtractDocumentOutput> {
	const { buffer, fileName } = input;
	const maxChars = Math.max(1, input.maxChars ?? DEFAULT_MAX_CHARS);

	if (buffer.byteLength > MAX_INPUT_BYTES) {
		throw new Error(
			`Document is too large (${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB). Maximum supported size is 50MB.`,
		);
	}

	const format = detectFormat(fileName, input.mimeType);
	const markitdownFirst =
		/^(1|true|on|yes)$/i.test(process.env.MAESTRO_MARKITDOWN_PREFER ?? "") &&
		!isMarkitdownDisabled();

	let extractedText = "";
	let extractor: ExtractDocumentOutput["extractor"] = "native";
	if (markitdownFirst) {
		const markitdownText = await extractWithMarkitdown({
			buffer,
			fileName,
			mimeType: input.mimeType,
		});
		if (markitdownText) {
			extractedText = markitdownText;
			extractor = "markitdown";
		}
	}

	if (!extractedText) {
		switch (format) {
			case "pdf": {
				const parser = new PDFParse({ data: buffer });
				try {
					const result = await parser.getText();
					extractedText = result.text || "";
				} finally {
					try {
						await parser.destroy();
					} catch {
						// ignore
					}
				}
				break;
			}
			case "docx": {
				const result = await mammoth.extractRawText({ buffer });
				extractedText = result.value || "";
				break;
			}
			case "xlsx": {
				const workbook = new ExcelJS.Workbook();
				await workbook.xlsx.load(buffer as unknown as ExcelWorkbookLoadInput);
				const parts: string[] = [];
				for (const worksheet of workbook.worksheets) {
					const rows = worksheetToRows(worksheet);
					if (rows.length === 0) continue;
					parts.push(
						`# Sheet: ${worksheet.name}\n${rows.map((row) => row.join("\t")).join("\n")}`,
					);
				}
				extractedText = parts.join("\n\n");
				break;
			}
			case "pptx": {
				extractedText = await extractPptxText(buffer);
				break;
			}
			case "text": {
				extractedText = buffer.toString("utf8");
				break;
			}
			default: {
				extractedText = "";
				break;
			}
		}
	}

	if (
		extractor !== "markitdown" &&
		shouldTryMarkitdown(format, fileName, input.mimeType)
	) {
		const markitdownText = await extractWithMarkitdown({
			buffer,
			fileName,
			mimeType: input.mimeType,
		});
		if (markitdownText) {
			extractedText = markitdownText;
			extractor = "markitdown";
		}
	}

	const { text, truncated } = clampText(extractedText, maxChars);
	return {
		extractedText: text,
		format,
		extractor,
		truncated,
		sizeBytes: buffer.byteLength,
	};
}
