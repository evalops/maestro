import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { afterEach, describe, expect, it } from "vitest";
import { extractDocumentText } from "../src/utils/document-extractor.js";

describe("extractDocumentText", () => {
	const originalEnv = { ...process.env };

	afterEach(() => {
		process.env = { ...originalEnv };
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
				expect(isProcessAlive(pid)).toBe(false);
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
