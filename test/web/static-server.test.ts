import { mkdtempSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { serveStatic } from "../../src/web/static-server.js";

interface MockResponse extends PassThrough {
	statusCode: number;
	headers: Record<string, string | number>;
	body: string;
	writeHead(status: number, headers?: Record<string, string | number>): void;
}

const makeRes = (): MockResponse => {
	const stream = new PassThrough();
	const originalEnd = stream.end.bind(stream);
	const res = Object.assign(stream, {
		statusCode: 200,
		headers: {} as Record<string, string | number>,
		body: "",
		writeHead(status: number, headers?: Record<string, string | number>) {
			this.statusCode = status;
			if (headers) this.headers = headers;
		},
		end(chunk?: string | Buffer) {
			originalEnd(chunk);
		},
	}) as MockResponse;
	stream.on("data", (chunk) => {
		res.body += chunk.toString();
	});
	return res;
};

interface MockRequest {
	headers: Record<string, string>;
}

describe("serveStatic", () => {
	it("returns 304 when ETag matches", () => {
		const root = mkdtempSync(join(tmpdir(), "static-"));
		const file = join(root, "index.html");
		writeFileSync(file, "<h1>hi</h1>");
		const res1 = makeRes();
		const req1: MockRequest = { headers: {} };
		serveStatic(
			"/",
			req1 as unknown as IncomingMessage,
			res1 as unknown as ServerResponse,
			{ webRoot: root },
		);
		const etag = res1.headers.ETag as string;
		const res2 = makeRes();
		const req2: MockRequest = { headers: { "if-none-match": etag } };
		serveStatic(
			"/",
			req2 as unknown as IncomingMessage,
			res2 as unknown as ServerResponse,
			{
				webRoot: root,
			},
		);
		expect(res2.statusCode).toBe(304);
		expect(res2.writableEnded).toBe(true);
	});

	it("blocks path traversal", () => {
		const root = mkdtempSync(join(tmpdir(), "static-"));
		const res = makeRes();
		const req: MockRequest = { headers: {} };
		serveStatic(
			"/../secret.txt",
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			{
				webRoot: root,
			},
		);
		expect(res.statusCode).toBe(403);
	});
});
