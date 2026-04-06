import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as mcp from "../../src/mcp/index.js";
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

function makeReq(
	url: string,
	options: { method?: string; body?: unknown } = {},
): MockPassThrough {
	const req = new PassThrough() as MockPassThrough;
	req.method = options.method ?? "GET";
	req.url = url;
	req.headers = { host: "localhost" };
	if (options.body !== undefined) {
		req.end(JSON.stringify(options.body));
	}
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
		vi.spyOn(mcp.mcpManager, "getStatus").mockReturnValue({
			servers: [
				{
					name: "docs",
					connected: true,
					transport: "http",
					scope: "project",
					tools: [],
					resources: ["memo://guide"],
					prompts: ["summarize"],
					remoteUrl: "https://mcp.linear.app/mcp",
					remoteHost: "mcp.linear.app",
					headerKeys: ["Authorization"],
					headersHelper: "bun run scripts/mcp-headers.ts",
					timeout: 20000,
					remoteTrust: "official",
					officialRegistry: {
						displayName: "Linear",
						documentationUrl: "https://linear.app/docs/mcp",
					},
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
					transport: "http",
					scope: "project",
					tools: [],
					resources: ["memo://guide"],
					prompts: ["summarize"],
					remoteUrl: "https://mcp.linear.app/mcp",
					remoteHost: "mcp.linear.app",
					headerKeys: ["Authorization"],
					headersHelper: "bun run scripts/mcp-headers.ts",
					timeout: 20000,
					remoteTrust: "official",
					officialRegistry: {
						displayName: "Linear",
						documentationUrl: "https://linear.app/docs/mcp",
					},
				},
			],
		});
	});

	it("reads MCP resources through the query action", async () => {
		const readResource = vi
			.spyOn(mcp.mcpManager, "readResource")
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

	it("gets MCP prompts through the query action", async () => {
		const getPrompt = vi.spyOn(mcp.mcpManager, "getPrompt").mockResolvedValue({
			description: "Summarize docs",
			messages: [{ role: "user", content: "Summarize MCP" }],
		});

		const req = makeReq(
			"/api/mcp?action=get-prompt&server=docs&name=summarize&arg%3Atopic=MCP",
		);
		const res = makeRes();

		await handleMcpStatus(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			corsHeaders,
		);

		expect(getPrompt).toHaveBeenCalledWith("docs", "summarize", {
			topic: "MCP",
		});
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toEqual({
			description: "Summarize docs",
			messages: [{ role: "user", content: "Summarize MCP" }],
		});
	});

	it("searches the official MCP registry", async () => {
		vi.spyOn(mcp, "prefetchOfficialMcpRegistry").mockResolvedValue(undefined);
		vi.spyOn(mcp, "getOfficialMcpRegistryEntries").mockReturnValue([
			{
				displayName: "Linear",
				slug: "linear",
				transport: "http",
				url: "https://mcp.linear.app/mcp",
			},
		]);
		vi.spyOn(mcp, "searchOfficialMcpRegistry").mockReturnValue([
			{
				displayName: "Linear",
				slug: "linear",
				transport: "http",
				url: "https://mcp.linear.app/mcp",
			},
		]);

		const req = makeReq("/api/mcp?action=search-registry&query=linear");
		const res = makeRes();

		await handleMcpStatus(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			corsHeaders,
		);

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toEqual({
			query: "linear",
			entries: [
				{
					displayName: "Linear",
					slug: "linear",
					transport: "http",
					url: "https://mcp.linear.app/mcp",
				},
			],
		});
	});

	it("imports an official MCP registry entry and reloads MCP config", async () => {
		vi.spyOn(mcp, "prefetchOfficialMcpRegistry").mockResolvedValue(undefined);
		vi.spyOn(mcp, "getOfficialMcpRegistryEntries").mockReturnValue([
			{
				displayName: "Linear",
				slug: "linear",
				transport: "http",
				url: "https://mcp.linear.app/mcp",
			},
		]);
		vi.spyOn(mcp, "resolveOfficialMcpRegistryEntry").mockReturnValue({
			entry: {
				displayName: "Linear",
				slug: "linear",
				transport: "http",
				url: "https://mcp.linear.app/mcp",
			},
			matches: [
				{
					displayName: "Linear",
					slug: "linear",
					transport: "http",
					url: "https://mcp.linear.app/mcp",
				},
			],
		});
		const loadConfig = vi
			.spyOn(mcp, "loadMcpConfig")
			.mockReturnValueOnce({ servers: [] })
			.mockReturnValueOnce({ servers: [] });
		const addConfig = vi.spyOn(mcp, "addMcpServerToConfig").mockReturnValue({
			path: "/tmp/project/.maestro/mcp.local.json",
		});
		const configure = vi
			.spyOn(mcp.mcpManager, "configure")
			.mockResolvedValue(undefined);

		const req = makeReq("/api/mcp?action=import-registry", {
			method: "POST",
			body: { query: "linear" },
		});
		const res = makeRes();

		await handleMcpStatus(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			corsHeaders,
		);

		expect(addConfig).toHaveBeenCalledWith({
			projectRoot: process.cwd(),
			scope: "local",
			server: {
				name: "linear",
				transport: "http",
				url: "https://mcp.linear.app/mcp",
			},
		});
		expect(loadConfig).toHaveBeenCalledWith(process.cwd(), {
			includeEnvLimits: true,
		});
		expect(configure).toHaveBeenCalledTimes(1);
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toEqual({
			name: "linear",
			scope: "local",
			path: "/tmp/project/.maestro/mcp.local.json",
			entry: {
				displayName: "Linear",
				slug: "linear",
				transport: "http",
				url: "https://mcp.linear.app/mcp",
			},
			server: {
				transport: "http",
				url: "https://mcp.linear.app/mcp",
			},
		});
	});

	it("adds a custom MCP server and reloads MCP config", async () => {
		vi.spyOn(mcp, "prefetchOfficialMcpRegistry").mockResolvedValue(undefined);
		const loadConfig = vi
			.spyOn(mcp, "loadMcpConfig")
			.mockReturnValueOnce({ servers: [] })
			.mockReturnValueOnce({
				servers: [
					{
						name: "custom-docs",
						transport: "http",
						url: "https://docs.example.com/mcp",
					},
				],
			});
		const addConfig = vi.spyOn(mcp, "addMcpServerToConfig").mockReturnValue({
			path: "/tmp/project/.maestro/mcp.json",
		});
		const configure = vi
			.spyOn(mcp.mcpManager, "configure")
			.mockResolvedValue(undefined);

		const req = makeReq("/api/mcp?action=add-server", {
			method: "POST",
			body: {
				scope: "project",
				server: {
					name: "custom-docs",
					url: "https://docs.example.com/mcp",
				},
			},
		});
		const res = makeRes();

		await handleMcpStatus(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			corsHeaders,
		);

		expect(addConfig).toHaveBeenCalledWith({
			projectRoot: process.cwd(),
			scope: "project",
			server: {
				name: "custom-docs",
				transport: "http",
				url: "https://docs.example.com/mcp",
			},
		});
		expect(loadConfig).toHaveBeenCalledWith(process.cwd(), {
			includeEnvLimits: true,
		});
		expect(configure).toHaveBeenCalledTimes(1);
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toEqual({
			name: "custom-docs",
			scope: "project",
			path: "/tmp/project/.maestro/mcp.json",
			server: {
				name: "custom-docs",
				transport: "http",
				url: "https://docs.example.com/mcp",
			},
		});
	});

	it("removes a writable MCP server and reports fallback state", async () => {
		const removeConfig = vi
			.spyOn(mcp, "removeMcpServerFromConfig")
			.mockReturnValue({
				path: "/tmp/project/.maestro/mcp.local.json",
				scope: "local",
			});
		const loadConfig = vi
			.spyOn(mcp, "loadMcpConfig")
			.mockReturnValueOnce({
				servers: [
					{
						name: "linear",
						scope: "user",
						transport: "http",
						url: "https://mcp.linear.app/mcp",
					},
				],
			})
			.mockReturnValueOnce({
				servers: [
					{
						name: "linear",
						scope: "user",
						transport: "http",
						url: "https://mcp.linear.app/mcp",
					},
				],
			});
		const configure = vi
			.spyOn(mcp.mcpManager, "configure")
			.mockResolvedValue(undefined);

		const req = makeReq("/api/mcp?action=remove-server", {
			method: "POST",
			body: {
				name: "linear",
				scope: "local",
			},
		});
		const res = makeRes();

		await handleMcpStatus(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			corsHeaders,
		);

		expect(removeConfig).toHaveBeenCalledWith({
			projectRoot: process.cwd(),
			scope: "local",
			name: "linear",
		});
		expect(loadConfig).toHaveBeenCalledWith(process.cwd(), {
			includeEnvLimits: true,
		});
		expect(configure).toHaveBeenCalledTimes(1);
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toEqual({
			name: "linear",
			scope: "local",
			path: "/tmp/project/.maestro/mcp.local.json",
			fallback: {
				name: "linear",
				scope: "user",
			},
		});
	});

	it("updates a writable MCP server and reloads MCP config", async () => {
		vi.spyOn(mcp, "prefetchOfficialMcpRegistry").mockResolvedValue(undefined);
		const loadConfig = vi
			.spyOn(mcp, "loadMcpConfig")
			.mockReturnValueOnce({
				servers: [
					{
						name: "linear",
						scope: "local",
						transport: "http",
						url: "https://mcp.linear.app/mcp",
						headersHelper: "bun run scripts/mcp-headers.ts",
						timeout: 20_000,
					},
				],
			})
			.mockReturnValueOnce({
				servers: [
					{
						name: "linear",
						scope: "local",
						transport: "sse",
						url: "https://mcp.linear.app/sse",
					},
				],
			});
		const updateConfig = vi
			.spyOn(mcp, "updateMcpServerInConfig")
			.mockReturnValue({
				path: "/tmp/project/.maestro/mcp.local.json",
				scope: "local",
			});
		const configure = vi
			.spyOn(mcp.mcpManager, "configure")
			.mockResolvedValue(undefined);

		const req = makeReq("/api/mcp?action=update-server", {
			method: "POST",
			body: {
				name: "linear",
				scope: "local",
				server: {
					name: "linear",
					transport: "sse",
					url: "https://mcp.linear.app/sse",
				},
			},
		});
		const res = makeRes();

		await handleMcpStatus(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			corsHeaders,
		);

		expect(updateConfig).toHaveBeenCalledWith({
			projectRoot: process.cwd(),
			scope: "local",
			name: "linear",
			server: {
				name: "linear",
				transport: "sse",
				url: "https://mcp.linear.app/sse",
				headersHelper: "bun run scripts/mcp-headers.ts",
				timeout: 20_000,
			},
		});
		expect(loadConfig).toHaveBeenCalledWith(process.cwd(), {
			includeEnvLimits: true,
		});
		expect(configure).toHaveBeenCalledTimes(1);
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toEqual({
			name: "linear",
			scope: "local",
			path: "/tmp/project/.maestro/mcp.local.json",
			server: {
				name: "linear",
				transport: "sse",
				url: "https://mcp.linear.app/sse",
				headersHelper: "bun run scripts/mcp-headers.ts",
				timeout: 20_000,
			},
		});
	});

	it("clears optional MCP update fields when null is provided", async () => {
		vi.spyOn(mcp, "prefetchOfficialMcpRegistry").mockResolvedValue(undefined);
		const loadConfig = vi
			.spyOn(mcp, "loadMcpConfig")
			.mockReturnValueOnce({
				servers: [
					{
						name: "linear",
						scope: "local",
						transport: "http",
						url: "https://mcp.linear.app/mcp",
						headers: {
							Authorization: "Bearer token",
						},
						headersHelper: "bun run scripts/mcp-headers.ts",
						timeout: 20_000,
					},
				],
			})
			.mockReturnValueOnce({
				servers: [
					{
						name: "linear",
						scope: "local",
						transport: "http",
						url: "https://mcp.linear.app/mcp",
					},
				],
			});
		const updateConfig = vi
			.spyOn(mcp, "updateMcpServerInConfig")
			.mockReturnValue({
				path: "/tmp/project/.maestro/mcp.local.json",
				scope: "local",
			});
		const configure = vi
			.spyOn(mcp.mcpManager, "configure")
			.mockResolvedValue(undefined);

		const req = makeReq("/api/mcp?action=update-server", {
			method: "POST",
			body: {
				name: "linear",
				scope: "local",
				server: {
					name: "linear",
					transport: "http",
					url: "https://mcp.linear.app/mcp",
					headers: null,
					headersHelper: null,
					timeout: null,
				},
			},
		});
		const res = makeRes();

		await handleMcpStatus(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			corsHeaders,
		);

		expect(updateConfig).toHaveBeenCalledWith({
			projectRoot: process.cwd(),
			scope: "local",
			name: "linear",
			server: {
				name: "linear",
				transport: "http",
				url: "https://mcp.linear.app/mcp",
			},
		});
		expect(loadConfig).toHaveBeenCalledWith(process.cwd(), {
			includeEnvLimits: true,
		});
		expect(configure).toHaveBeenCalledTimes(1);
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toEqual({
			name: "linear",
			scope: "local",
			path: "/tmp/project/.maestro/mcp.local.json",
			server: {
				name: "linear",
				transport: "http",
				url: "https://mcp.linear.app/mcp",
			},
		});
	});

	it("validates required query parameters for prompt reads", async () => {
		const req = makeReq("/api/mcp?action=get-prompt&server=docs");
		const res = makeRes();

		await handleMcpStatus(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			corsHeaders,
		);

		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body)).toEqual({
			error: "Missing required query parameters: server and name",
		});
	});
});
