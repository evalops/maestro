import { createServer, request } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serveStatic } from "../src/server/static-server.js";

function startStaticServer(): Promise<{
	baseUrl: string;
	close: () => Promise<void>;
}> {
	const webRoot = join(process.cwd(), "packages/web");
	const server = createServer((req, res) => {
		const url = new URL(req.url || "/", "http://localhost");
		serveStatic(url.pathname, req, res, { webRoot, spaFallback: true });
	});

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port =
				typeof addr === "object" && addr && "port" in addr ? addr.port : 0;
			resolve({
				baseUrl: `http://127.0.0.1:${port}`,
				close: () =>
					new Promise((r) => {
						server.close(() => r());
					}),
			});
		});
	});
}

async function httpGet(
	url: string,
	opts?: { headers?: Record<string, string> },
) {
	return await new Promise<{
		status: number;
		headers: Record<string, string | string[] | undefined>;
		body: string;
	}>((resolve, reject) => {
		const u = new URL(url);
		const req = request(
			{
				method: "GET",
				hostname: u.hostname,
				port: Number(u.port),
				pathname: u.pathname,
				path: `${u.pathname}${u.search}`,
				headers: opts?.headers,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c) => chunks.push(Buffer.from(c)));
				res.on("end", () => {
					resolve({
						status: res.statusCode || 0,
						headers: res.headers,
						body: Buffer.concat(chunks).toString("utf8"),
					});
				});
			},
		);
		req.on("error", reject);
		req.end();
	});
}

describe("serveStatic SPA fallback", () => {
	let closer: (() => Promise<void>) | null = null;

	afterEach(async () => {
		if (closer) await closer();
		closer = null;
	});

	it("serves index.html for /share/:token when Accept prefers html", async () => {
		const { baseUrl, close } = await startStaticServer();
		closer = close;

		const res = await httpGet(`${baseUrl}/share/abc123`, {
			headers: { Accept: "text/html" },
		});
		expect(res.status).toBe(200);
		expect(String(res.headers["content-type"] || "")).toContain("text/html");
		expect(res.body).toContain("<composer-chat");
	});

	it("does not fall back for missing assets", async () => {
		const { baseUrl, close } = await startStaticServer();
		closer = close;

		const res = await httpGet(`${baseUrl}/assets/does-not-exist.js`, {
			headers: { Accept: "text/html" },
		});
		expect(res.status).toBe(404);
	});

	it("does not fall back when Accept does not include html", async () => {
		const { baseUrl, close } = await startStaticServer();
		closer = close;

		const res = await httpGet(`${baseUrl}/share/abc123`, {
			headers: { Accept: "application/json" },
		});
		expect(res.status).toBe(404);
	});
});
