import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const cors = { "Access-Control-Allow-Origin": "*" };
const apiKey = "preview-test-key";
type PreviewHandler = (
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) => Promise<void>;
let handlePreview: PreviewHandler;
let originalApiKey: string | undefined;

interface MockResponse {
	statusCode: number;
	headers: Record<string, string>;
	body: string;
	writableEnded: boolean;
	headersSent?: boolean;
	on: () => void;
	off: () => void;
	writeHead(status: number, headers?: Record<string, string>): void;
	write(chunk: string | Buffer): void;
	end(chunk?: string | Buffer): void;
}

function makeRes(): MockResponse {
	return {
		statusCode: 200,
		headers: {},
		body: "",
		writableEnded: false,
		headersSent: false,
		on: () => {},
		off: () => {},
		writeHead(status: number, headers?: Record<string, string>) {
			this.statusCode = status;
			this.headers = headers || {};
			this.headersSent = true;
		},
		write(chunk: string | Buffer) {
			this.body += chunk.toString();
		},
		end(chunk?: string | Buffer) {
			if (chunk) this.write(chunk);
			this.writableEnded = true;
		},
	};
}

interface MockRequest extends PassThrough {
	method: string;
	url: string;
	headers: Record<string, string>;
}

describe("handlePreview", () => {
	beforeAll(async () => {
		originalApiKey = process.env.COMPOSER_WEB_API_KEY;
		process.env.COMPOSER_WEB_API_KEY = apiKey;
		({ handlePreview } = await import("../../src/server/handlers/preview.js"));
	});

	afterAll(() => {
		process.env.COMPOSER_WEB_API_KEY = originalApiKey;
	});

	it("returns 200 with no changes for tracked files", async () => {
		const repoRoot = mkdtempSync(join(tmpdir(), "preview-test-"));
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
		try {
			execFileSync("git", ["init"], { cwd: repoRoot });
			writeFileSync(join(repoRoot, "hello.txt"), "hello\n", "utf-8");
			execFileSync("git", ["add", "hello.txt"], { cwd: repoRoot });

			const req = new PassThrough() as MockRequest;
			req.method = "GET";
			req.url = "/api/preview?file=hello.txt";
			req.headers = { "x-composer-api-key": apiKey };
			const res = makeRes();

			await handlePreview(
				req as unknown as IncomingMessage,
				res as unknown as ServerResponse,
				cors,
			);

			const payload = JSON.parse(res.body) as {
				diff: string;
				hasChanges: boolean;
			};
			expect(res.statusCode).toBe(200);
			expect(payload.hasChanges).toBe(false);
			expect(payload.diff).toBe("No changes");
		} finally {
			cwdSpy.mockRestore();
			rmSync(repoRoot, { recursive: true, force: true });
		}
	});

	it("rejects repo root paths", async () => {
		const repoRoot = mkdtempSync(join(tmpdir(), "preview-root-"));
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
		try {
			execFileSync("git", ["init"], { cwd: repoRoot });

			const req = new PassThrough() as MockRequest;
			req.method = "GET";
			req.url = "/api/preview?file=.";
			req.headers = { "x-composer-api-key": apiKey };
			const res = makeRes();

			await handlePreview(
				req as unknown as IncomingMessage,
				res as unknown as ServerResponse,
				cors,
			);

			const payload = JSON.parse(res.body) as { error: string };
			expect(res.statusCode).toBe(400);
			expect(payload.error).toContain("Invalid file path");
		} finally {
			cwdSpy.mockRestore();
			rmSync(repoRoot, { recursive: true, force: true });
		}
	});

	it("rejects symlinks that resolve outside repo", async () => {
		if (process.platform === "win32") {
			return;
		}

		const repoRoot = mkdtempSync(join(tmpdir(), "preview-symlink-"));
		const outsideRoot = mkdtempSync(join(tmpdir(), "preview-outside-"));
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
		try {
			execFileSync("git", ["init"], { cwd: repoRoot });
			writeFileSync(join(outsideRoot, "secret.txt"), "secret\n", "utf-8");
			symlinkSync(join(outsideRoot, "secret.txt"), join(repoRoot, "leak.txt"));

			const req = new PassThrough() as MockRequest;
			req.method = "GET";
			req.url = "/api/preview?file=leak.txt";
			req.headers = { "x-composer-api-key": apiKey };
			const res = makeRes();

			await handlePreview(
				req as unknown as IncomingMessage,
				res as unknown as ServerResponse,
				cors,
			);

			const payload = JSON.parse(res.body) as { error: string };
			expect(res.statusCode).toBe(400);
			expect(payload.error).toContain("Invalid file path");
		} finally {
			cwdSpy.mockRestore();
			rmSync(repoRoot, { recursive: true, force: true });
			rmSync(outsideRoot, { recursive: true, force: true });
		}
	});
});
