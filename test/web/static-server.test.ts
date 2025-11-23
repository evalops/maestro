import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { serveStatic } from "../../src/web/static-server.js";

const makeRes = () => {
	const stream = new PassThrough();
	const originalEnd = stream.end.bind(stream);
	const res: any = Object.assign(stream, {
		statusCode: 200,
		headers: {} as Record<string, string | number>,
		body: "",
		writeHead(status: number, headers?: Record<string, any>) {
			this.statusCode = status;
			if (headers) this.headers = headers;
		},
		end(chunk?: string | Buffer) {
			originalEnd(chunk);
		},
	});
	stream.on("data", (chunk) => {
		res.body += chunk.toString();
	});
	return res;
};

describe("serveStatic", () => {
	it("returns 304 when ETag matches", () => {
		const root = mkdtempSync(join(tmpdir(), "static-"));
		const file = join(root, "index.html");
		writeFileSync(file, "<h1>hi</h1>");
		const res1 = makeRes();
		serveStatic("/", { headers: {} } as any, res1, { webRoot: root });
		const etag = res1.headers.ETag as string;
		const res2 = makeRes();
		serveStatic("/", { headers: { "if-none-match": etag } } as any, res2, {
			webRoot: root,
		});
		expect(res2.statusCode).toBe(304);
		expect(res2.writableEnded).toBe(true);
	});

	it("blocks path traversal", () => {
		const root = mkdtempSync(join(tmpdir(), "static-"));
		const res = makeRes();
		serveStatic("/../secret.txt", { headers: {} } as any, res, {
			webRoot: root,
		});
		expect(res.statusCode).toBe(403);
	});
});
