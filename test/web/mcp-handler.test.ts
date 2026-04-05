import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mcpManager } from "../../src/mcp/index.js";
import { handleMcpStatus } from "../../src/server/handlers/mcp.js";

const corsHeaders = { "Access-Control-Allow-Origin": "*" };

interface MockPassThrough extends PassThrough {
	method: string;
	url: string;
	headers: Record<string, string>;
}

interface MockResponse {
	statusCode: number;
	headers: Record<string, string>;
	body: string;
	writableEnded: boolean;
	on: () => void;
	off: () => void;
	writeHead(status: number, headers?: Record<string, string>): void;
	write(chunk: string | Buffer): void;
	end(chunk?: string | Buffer): void;
}

function makeReq(url: string): MockPassThrough {
	const req = new PassThrough() as MockPassThrough;
	req.method = "GET";
	req.url = url;
	req.headers = { host: "localhost" };
	return req;
}

function makeRes(): MockResponse {
	return {
		statusCode: 200,
		headers: {},
		body: "",
		writableEnded: false,
		on: () => {},
		off: () => {},
		writeHead(status: number, headers?: Record<string, string>) {
			this.statusCode = status;
			this.headers = headers || {};
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

describe("handleMcpStatus", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns MCP status by default", async () => {
		vi.spyOn(mcpManager, "getStatus").mockReturnValue({
			servers: [
				{
					name: "docs",
					connected: true,
					transport: "stdio",
					scope: "project",
					tools: [],
					resources: ["memo://guide"],
					prompts: ["summarize"],
				},
			],
		});

		const req = makeReq("/api/mcp");
		const res = makeRes();

		await handleMcpStatus(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			corsHeaders,
		);

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toEqual({
			servers: [
				{
					name: "docs",
					connected: true,
					transport: "stdio",
					scope: "project",
					tools: [],
					resources: ["memo://guide"],
					prompts: ["summarize"],
				},
			],
		});
	});

	it("reads MCP resources through the query action", async () => {
		const readResource = vi
			.spyOn(mcpManager, "readResource")
			.mockResolvedValue({
				contents: [
					{
						uri: "memo://guide",
						text: "Guide body",
						mimeType: "text/plain",
					},
				],
			});

		const req = makeReq(
			"/api/mcp?action=read-resource&server=docs&uri=memo%3A%2F%2Fguide",
		);
		const res = makeRes();

		await handleMcpStatus(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			corsHeaders,
		);

		expect(readResource).toHaveBeenCalledWith("docs", "memo://guide");
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toEqual({
			contents: [
				{
					uri: "memo://guide",
					text: "Guide body",
					mimeType: "text/plain",
				},
			],
		});
	});

	it("validates required query parameters for resource reads", async () => {
		const req = makeReq("/api/mcp?action=read-resource&server=docs");
		const res = makeRes();

		await handleMcpStatus(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			corsHeaders,
		);

		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body)).toEqual({
			error: "Missing required query parameters: server and uri",
		});
	});
});
