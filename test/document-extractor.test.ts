import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractDocumentText } from "../src/utils/document-extractor.js";

describe("extractDocumentText", () => {
	const originalEnv = { ...process.env };

	afterEach(() => {
		process.env = { ...originalEnv };
		vi.doUnmock("exceljs");
		vi.doUnmock("mammoth");
		vi.resetModules();
	});

	function isProcessAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	function killPid(pid: number): void {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// The timeout cleanup path may already have reaped it.
		}
	}

	async function waitForProcessExit(
		pid: number,
		timeoutMs = 5_000,
	): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (!isProcessAlive(pid)) {
				return true;
			}
			await delay(25);
		}
		return !isProcessAlive(pid);
	}

	function patchZipCentralDirectoryUncompressedSize(
		buffer: Buffer,
		entryName: string,
		size: number,
	): Buffer {
		const patched = Buffer.from(buffer);
		const entryNameBuffer = Buffer.from(entryName, "utf8");

		for (let offset = 0; offset <= patched.length - 46; offset += 1) {
			if (patched.readUInt32LE(offset) !== 0x02014b50) continue;
			const nameLength = patched.readUInt16LE(offset + 28);
			const extraLength = patched.readUInt16LE(offset + 30);
			const commentLength = patched.readUInt16LE(offset + 32);
			const nameStart = offset + 46;
			const nameEnd = nameStart + nameLength;
			if (nameEnd > patched.length) break;
			if (patched.subarray(nameStart, nameEnd).equals(entryNameBuffer)) {
				patched.writeUInt32LE(size, offset + 24);
				return patched;
			}
			offset = nameEnd + extraLength + commentLength - 1;
		}

		throw new Error(
			`Could not locate ZIP central directory entry ${entryName}`,
		);
	}

	it("extracts text files", async () => {
		process.env.MAESTRO_MARKITDOWN = "0";
		const out = await extractDocumentText({
			buffer: Buffer.from("hello\nworld\n", "utf8"),
			fileName: "notes.txt",
			mimeType: "text/plain",
		});
		expect(out.format).toBe("text");
		expect(out.extractor).toBe("native");
		expect(out.extractedText).toContain("hello");
		expect(out.truncated).toBe(false);
	});

	it("extracts xlsx files into tab-separated text", async () => {
		process.env.MAESTRO_MARKITDOWN = "0";
		const workbook = new ExcelJS.Workbook();
		const worksheet = workbook.addWorksheet("People");
		worksheet.addRow(["Name", "Age"]);
		worksheet.addRow(["Alice", 30]);
		const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

		const out = await extractDocumentText({
			buffer,
			fileName: "people.xlsx",
			mimeType:
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		});

		expect(out.format).toBe("xlsx");
		expect(out.extractor).toBe("native");
		expect(out.extractedText).toContain("# Sheet: People");
		expect(out.extractedText).toContain("Alice");
	});

	it("extracts pptx slide text without regex expansion", async () => {
		process.env.MAESTRO_MARKITDOWN = "0";
		const zip = new JSZip();
		zip.file(
			"ppt/slides/slide1.xml",
			"<p:sld><a:t>Hello &amp; welcome</a:t><a:t>Team</a:t></p:sld>",
		);
		const buffer = Buffer.from(await zip.generateAsync({ type: "uint8array" }));

		const out = await extractDocumentText({
			buffer,
			fileName: "deck.pptx",
			mimeType:
				"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		});

		expect(out.format).toBe("pptx");
		expect(out.extractor).toBe("native");
		expect(out.extractedText).toContain("# Slide 1");
		expect(out.extractedText).toContain("Hello & welcome Team");
	});

	it("skips non-text DrawingML tags before later pptx text runs", async () => {
		process.env.MAESTRO_MARKITDOWN = "0";
		const zip = new JSZip();
		zip.file(
			"ppt/slides/slide1.xml",
			"<p:sld><a:tab/><a:tbl><a:tc/></a:tbl><a:t>Later text</a:t></p:sld>",
		);
		const buffer = Buffer.from(await zip.generateAsync({ type: "uint8array" }));

		const out = await extractDocumentText({
			buffer,
			fileName: "deck.pptx",
			mimeType:
				"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		});

		expect(out.extractedText).toContain("Later text");
	});

	it("rejects OOXML archives before parser inflation when decompressed bytes exceed the limit", async () => {
		process.env.MAESTRO_MARKITDOWN = "0";
		process.env.MAESTRO_DOCUMENT_MAX_ZIP_DECOMPRESSED_BYTES = "100";
		const zip = new JSZip();
		zip.file("xl/workbook.xml", "a".repeat(101));
		const buffer = Buffer.from(await zip.generateAsync({ type: "uint8array" }));

		await expect(
			extractDocumentText({
				buffer,
				fileName: "bomb.xlsx",
				mimeType:
					"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			}),
		).rejects.toThrow(/decompressed size is too large/i);
	});

	it("rejects docx entries when actual inflated bytes exceed the limit despite understated metadata", async () => {
		process.env.MAESTRO_MARKITDOWN = "0";
		process.env.MAESTRO_DOCUMENT_MAX_ZIP_DECOMPRESSED_BYTES = "100";
		const zip = new JSZip();
		zip.file(
			"[Content_Types].xml",
			`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
		);
		zip.file(
			"_rels/.rels",
			`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
		);
		zip.file(
			"word/document.xml",
			`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${"a".repeat(101)}</w:t></w:r></w:p></w:body></w:document>`,
		);
		const buffer = patchZipCentralDirectoryUncompressedSize(
			Buffer.from(await zip.generateAsync({ type: "uint8array" })),
			"word/document.xml",
			1,
		);
		const extractRawText = vi.fn(async () => ({ value: "should not run" }));
		vi.doMock("mammoth", () => ({
			default: { extractRawText },
		}));
		const { extractDocumentText: isolatedExtractDocumentText } = await import(
			"../src/utils/document-extractor.js"
		);

		await expect(
			isolatedExtractDocumentText({
				buffer,
				fileName: "bomb.docx",
				mimeType:
					"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			}),
		).rejects.toThrow(/decompressed size is too large/i);
		expect(extractRawText).not.toHaveBeenCalled();
	});

	it("rejects zip entries while streaming when actual inflated bytes exceed the entry limit", async () => {
		process.env.MAESTRO_MARKITDOWN = "0";
		process.env.MAESTRO_DOCUMENT_MAX_ZIP_ENTRY_BYTES = "100";
		process.env.MAESTRO_DOCUMENT_MAX_ZIP_DECOMPRESSED_BYTES = "10000";
		const zip = new JSZip();
		zip.file("ppt/slides/slide1.xml", `<a:t>${"a".repeat(101)}</a:t>`);
		const buffer = patchZipCentralDirectoryUncompressedSize(
			Buffer.from(await zip.generateAsync({ type: "uint8array" })),
			"ppt/slides/slide1.xml",
			1,
		);

		await expect(
			extractDocumentText({
				buffer,
				fileName: "bomb.pptx",
				mimeType:
					"application/vnd.openxmlformats-officedocument.presentationml.presentation",
			}),
		).rejects.toThrow(/entry is too large/i);
	});

	it("rejects xlsx entries when actual inflated bytes exceed the limit despite understated metadata", async () => {
		process.env.MAESTRO_MARKITDOWN = "0";
		process.env.MAESTRO_DOCUMENT_MAX_ZIP_DECOMPRESSED_BYTES = "100";
		const zip = new JSZip();
		zip.file(
			"[Content_Types].xml",
			`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
		);
		zip.file(
			"_rels/.rels",
			`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
		);
		zip.file(
			"xl/workbook.xml",
			`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></sheets></workbook>`,
		);
		zip.file(
			"xl/worksheets/sheet1.xml",
			`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${"a".repeat(101)}</t></is></c></row></sheetData></worksheet>`,
		);
		const buffer = patchZipCentralDirectoryUncompressedSize(
			Buffer.from(await zip.generateAsync({ type: "uint8array" })),
			"xl/worksheets/sheet1.xml",
			1,
		);
		const load = vi.fn(async () => undefined);
		vi.doMock("exceljs", () => ({
			default: {
				Workbook: class {
					worksheets: unknown[] = [];
					xlsx = { load };
				},
			},
		}));
		const { extractDocumentText: isolatedExtractDocumentText } = await import(
			"../src/utils/document-extractor.js"
		);

		await expect(
			isolatedExtractDocumentText({
				buffer,
				fileName: "bomb.xlsx",
				mimeType:
					"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			}),
		).rejects.toThrow(/decompressed size is too large/i);
		expect(load).not.toHaveBeenCalled();
	});

	it("rejects OOXML archives with too many entries", async () => {
		process.env.MAESTRO_MARKITDOWN = "0";
		process.env.MAESTRO_DOCUMENT_MAX_ZIP_ENTRIES = "2";
		const zip = new JSZip();
		zip.file("ppt/slides/slide1.xml", "<a:t>one</a:t>");
		zip.file("ppt/slides/slide2.xml", "<a:t>two</a:t>");
		zip.file("ppt/slides/slide3.xml", "<a:t>three</a:t>");
		const buffer = Buffer.from(await zip.generateAsync({ type: "uint8array" }));

		await expect(
			extractDocumentText({
				buffer,
				fileName: "deck.pptx",
				mimeType:
					"application/vnd.openxmlformats-officedocument.presentationml.presentation",
			}),
		).rejects.toThrow(/too many entries/i);
	});

	it("counts directory entries toward the OOXML zip entry limit", async () => {
		process.env.MAESTRO_MARKITDOWN = "0";
		process.env.MAESTRO_DOCUMENT_MAX_ZIP_ENTRIES = "2";
		const zip = new JSZip();
		zip.folder("ppt/");
		zip.folder("ppt/slides/");
		zip.file("ppt/slides/slide1.xml", "<a:t>one</a:t>");
		const buffer = Buffer.from(await zip.generateAsync({ type: "uint8array" }));

		await expect(
			extractDocumentText({
				buffer,
				fileName: "deck.pptx",
				mimeType:
					"application/vnd.openxmlformats-officedocument.presentationml.presentation",
			}),
		).rejects.toThrow(/too many entries/i);
	});

	it("returns unknown for unsupported formats", async () => {
		process.env.MAESTRO_MARKITDOWN = "0";
		const out = await extractDocumentText({
			buffer: Buffer.from([0, 1, 2, 3]),
			fileName: "blob.bin",
			mimeType: "application/octet-stream",
		});
		expect(out.format).toBe("unknown");
		expect(out.extractor).toBe("native");
		expect(out.extractedText).toBe("");
	});

	it("uses MarkItDown CLI output when a configured converter is available", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-markitdown-test-"));
		try {
			const script = join(dir, "fake-markitdown.mjs");
			await writeFile(
				script,
				"process.stdout.write('# Converted by MarkItDown\\n\\nBody text from fake CLI');",
				"utf8",
			);
			process.env.MAESTRO_MARKITDOWN_CMD = process.execPath;
			process.env.MAESTRO_MARKITDOWN_ARGS = script;

			const out = await extractDocumentText({
				buffer: Buffer.from(
					"<html><body><h1>Ignored native HTML</h1></body></html>",
				),
				fileName: "brief.html",
				mimeType: "text/html",
			});

			expect(out.format).toBe("text");
			expect(out.extractor).toBe("markitdown");
			expect(out.extractedText).toContain("# Converted by MarkItDown");
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("preserves quoted configured MarkItDown args", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-markitdown-test-"));
		try {
			const script = join(dir, "fake markitdown with spaces.mjs");
			await writeFile(
				script,
				`
const banner = process.argv.find((arg) => arg.startsWith("--banner="));
if (banner !== "--banner=quoted value") {
	console.error(JSON.stringify(process.argv));
	process.exit(2);
}
process.stdout.write(banner);
`,
				"utf8",
			);
			process.env.MAESTRO_MARKITDOWN_CMD = process.execPath;
			process.env.MAESTRO_MARKITDOWN_ARGS = `"${script}" "--banner=quoted value"`;

			const out = await extractDocumentText({
				buffer: Buffer.from("<html><body><h1>Fallback</h1></body></html>"),
				fileName: "brief.html",
				mimeType: "text/html",
			});

			expect(out.extractor).toBe("markitdown");
			expect(out.extractedText).toBe("--banner=quoted value");
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("preserves backslashes inside quoted configured MarkItDown args", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-markitdown-test-"));
		try {
			const script = join(dir, "fake-markitdown.mjs");
			const expectedPath = String.raw`C:\Program Files\tool\run.mjs`;
			await writeFile(
				script,
				`
const pathArg = process.argv.find((arg) => arg.startsWith("--path="));
if (pathArg !== ${JSON.stringify(`--path=${expectedPath}`)}) {
	console.error(JSON.stringify(process.argv));
	process.exit(2);
}
process.stdout.write(pathArg);
`,
				"utf8",
			);
			process.env.MAESTRO_MARKITDOWN_CMD = process.execPath;
			process.env.MAESTRO_MARKITDOWN_ARGS = `"${script}" "--path=${expectedPath}"`;

			const out = await extractDocumentText({
				buffer: Buffer.from("<html><body><h1>Fallback</h1></body></html>"),
				fileName: "brief.html",
				mimeType: "text/html",
			});

			expect(out.extractor).toBe("markitdown");
			expect(out.extractedText).toBe(`--path=${expectedPath}`);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("preserves unquoted backslashes in configured MarkItDown args", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-markitdown-test-"));
		try {
			const script = join(dir, "fake-markitdown.mjs");
			const expectedPath = String.raw`C:\tools\markitdown.py`;
			await writeFile(
				script,
				`
const pathArg = process.argv.find((arg) => arg.startsWith("--path="));
if (pathArg !== ${JSON.stringify(`--path=${expectedPath}`)}) {
	console.error(JSON.stringify(process.argv));
	process.exit(2);
}
process.stdout.write(pathArg);
`,
				"utf8",
			);
			process.env.MAESTRO_MARKITDOWN_CMD = process.execPath;
			process.env.MAESTRO_MARKITDOWN_ARGS = `${script} --path=${expectedPath}`;

			const out = await extractDocumentText({
				buffer: Buffer.from("<html><body><h1>Fallback</h1></body></html>"),
				fileName: "brief.html",
				mimeType: "text/html",
			});

			expect(out.extractor).toBe("markitdown");
			expect(out.extractedText).toBe(`--path=${expectedPath}`);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("waits for a timed-out MarkItDown process tree to exit", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-markitdown-test-"));
		const pidFile = join(dir, "pids.txt");
		let pids: number[] = [];
		try {
			const script = join(dir, "ignore-sigterm.mjs");
			await writeFile(
				script,
				`
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const pidFile = process.argv[process.argv.indexOf("--pid-file") + 1];
const child = spawn(process.execPath, [
	"-e",
	"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
], { stdio: "ignore" });
writeFileSync(pidFile, [process.pid, child.pid].join("\\n"));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
				"utf8",
			);
			process.env.MAESTRO_MARKITDOWN_CMD = process.execPath;
			process.env.MAESTRO_MARKITDOWN_ARGS = `"${script}" --pid-file "${pidFile}"`;
			process.env.MAESTRO_MARKITDOWN_TIMEOUT_MS = "1000";
			process.env.MAESTRO_MARKITDOWN_KILL_GRACE_MS = "100";

			await expect(
				extractDocumentText({
					buffer: Buffer.from("<html><body><h1>Fallback</h1></body></html>"),
					fileName: "brief.html",
					mimeType: "text/html",
				}),
			).rejects.toThrow("MarkItDown conversion timed out");

			pids = (await readFile(pidFile, "utf8"))
				.split(/\s+/)
				.filter(Boolean)
				.map((value) => Number.parseInt(value, 10));
			expect(pids).not.toHaveLength(0);
			for (const pid of pids) {
				expect(await waitForProcessExit(pid)).toBe(true);
			}
		} finally {
			for (const pid of pids) {
				killPid(pid);
			}
			await rm(dir, { force: true, recursive: true });
		}
	}, 30_000);

	it("falls back for fractional MarkItDown timeout env values", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-markitdown-test-"));
		try {
			const script = join(dir, "slow-success.mjs");
			await writeFile(
				script,
				`
setTimeout(() => {
	process.stdout.write("# Converted after fractional timeout fallback");
}, 25);
`,
				"utf8",
			);
			process.env.MAESTRO_MARKITDOWN_CMD = process.execPath;
			process.env.MAESTRO_MARKITDOWN_ARGS = script;
			process.env.MAESTRO_MARKITDOWN_TIMEOUT_MS = "0.5";

			const out = await extractDocumentText({
				buffer: Buffer.from("<html><body><h1>Fallback</h1></body></html>"),
				fileName: "brief.html",
				mimeType: "text/html",
			});

			expect(out.extractor).toBe("markitdown");
			expect(out.extractedText).toContain("fractional timeout fallback");
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("clamps oversized MarkItDown timeout env values", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-markitdown-test-"));
		try {
			const script = join(dir, "slow-success.mjs");
			await writeFile(
				script,
				`
setTimeout(() => {
	process.stdout.write("# Converted after oversized timeout clamp");
}, 25);
`,
				"utf8",
			);
			process.env.MAESTRO_MARKITDOWN_CMD = process.execPath;
			process.env.MAESTRO_MARKITDOWN_ARGS = script;
			process.env.MAESTRO_MARKITDOWN_TIMEOUT_MS = "2147483648";

			const out = await extractDocumentText({
				buffer: Buffer.from("<html><body><h1>Fallback</h1></body></html>"),
				fileName: "brief.html",
				mimeType: "text/html",
			});

			expect(out.extractor).toBe("markitdown");
			expect(out.extractedText).toContain("oversized timeout clamp");
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});
});
