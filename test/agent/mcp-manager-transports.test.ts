import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithMcpClientToolService } from "../../src/mcp/elicitation.js";

const mockClientConnect = vi.fn();
const mockClientClose = vi.fn();
const mockSetNotificationHandler = vi.fn();
const mockSetRequestHandler = vi.fn();
const mockListPrompts = vi.fn().mockResolvedValue({ prompts: [] });
const sseTransportCtor = vi.fn();
const httpTransportCtor = vi.fn();
const clientCtorOptions: unknown[] = [];

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: class MockClient {
		constructor(_clientInfo: unknown, options?: unknown) {
			clientCtorOptions.push(options);
		}

		connect = mockClientConnect.mockResolvedValue(undefined);
		getServerCapabilities = vi.fn(() => ({
			tools: {},
			resources: {},
			prompts: {},
		}));
		listTools = vi.fn().mockResolvedValue({ tools: [] });
		listResources = vi.fn().mockResolvedValue({ resources: [] });
		listPrompts = mockListPrompts;
		setNotificationHandler = mockSetNotificationHandler;
		setRequestHandler = mockSetRequestHandler;
		close = mockClientClose.mockResolvedValue(undefined);
	},
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
	SSEClientTransport: class MockSSEClientTransport {
		constructor(url: URL, options?: unknown) {
			sseTransportCtor(url, options);
		}

		async close() {}
	},
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
	StreamableHTTPClientTransport: class MockStreamableHTTPClientTransport {
		constructor(url: URL, options?: unknown) {
			httpTransportCtor(url, options);
		}

		async close() {}
	},
}));

import { McpClientManager } from "../../src/mcp/manager.js";

describe("MCP manager remote transports", () => {
	let manager: McpClientManager;
	let tempDir: string;

	beforeEach(() => {
		manager = new McpClientManager();
		tempDir = join(tmpdir(), `maestro-mcp-transport-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		mockClientConnect.mockClear();
		mockClientClose.mockClear();
		mockSetNotificationHandler.mockClear();
		mockSetRequestHandler.mockClear();
		mockListPrompts.mockReset().mockResolvedValue({ prompts: [] });
		sseTransportCtor.mockClear();
		httpTransportCtor.mockClear();
		clientCtorOptions.length = 0;
	});

	afterEach(async () => {
		await manager.disconnectAll();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("uses streamable HTTP transport for http servers", async () => {
		await manager.configure({
			servers: [
				{
					name: "remote-http",
					transport: "http",
					url: "https://example.com/mcp",
				},
			],
		});

		expect(httpTransportCtor).toHaveBeenCalledTimes(1);
		expect(sseTransportCtor).not.toHaveBeenCalled();
		expect(String(httpTransportCtor.mock.calls[0]![0])).toBe(
			"https://example.com/mcp",
		);
		expect(manager.isConnected("remote-http")).toBe(true);
	});

	it("uses SSE transport for sse servers", async () => {
		await manager.configure({
			servers: [
				{
					name: "remote-sse",
					transport: "sse",
					url: "https://example.com/sse",
				},
			],
		});

		expect(sseTransportCtor).toHaveBeenCalledTimes(1);
		expect(httpTransportCtor).not.toHaveBeenCalled();
		expect(String(sseTransportCtor.mock.calls[0]![0])).toBe(
			"https://example.com/sse",
		);
		expect(manager.isConnected("remote-sse")).toBe(true);
	});

	it("surfaces MCP prompt metadata in status", async () => {
		mockListPrompts.mockResolvedValueOnce({
			prompts: [
				{
					name: "summarize-issue",
					title: "Summarize Issue",
					description: "Summarize a ticket by id.",
					arguments: [
						{
							name: "ISSUE",
							description: "Issue identifier",
							required: true,
						},
					],
				},
			],
		});

		await manager.configure({
			servers: [
				{
					name: "remote-http",
					transport: "http",
					url: "https://example.com/mcp",
				},
			],
		});

		expect(manager.getStatus().servers[0]).toMatchObject({
			name: "remote-http",
			prompts: ["summarize-issue"],
			promptDetails: [
				{
					name: "summarize-issue",
					title: "Summarize Issue",
					description: "Summarize a ticket by id.",
					arguments: [
						{
							name: "ISSUE",
							description: "Issue identifier",
							required: true,
						},
					],
				},
			],
		});
	});

	it("reconnects a server when the same name is reconfigured", async () => {
		await manager.configure({
			servers: [
				{
					name: "remote-http",
					transport: "http",
					url: "https://example.com/mcp",
				},
			],
		});

		mockClientClose.mockClear();

		await manager.configure({
			servers: [
				{
					name: "remote-http",
					transport: "http",
					url: "https://example.com/mcp/v2",
				},
			],
		});

		expect(mockClientClose).toHaveBeenCalledTimes(1);
		expect(httpTransportCtor).toHaveBeenCalledTimes(2);
		expect(String(httpTransportCtor.mock.calls[1]![0])).toBe(
			"https://example.com/mcp/v2",
		);
		expect(manager.isConnected("remote-http")).toBe(true);
	});

	it("merges static headers with headersHelper output for remote transports", async () => {
		const helperPath = join(tempDir, "headers-helper.sh");
		writeFileSync(
			helperPath,
			[
				"#!/bin/sh",
				'printf \'{"Authorization":"Bearer dynamic","X-Dynamic":"%s","X-Server":"%s"}\' "$TOKEN_VALUE" "$MAESTRO_MCP_SERVER_NAME"',
				"",
			].join("\n"),
		);
		chmodSync(helperPath, 0o755);

		await manager.configure({
			servers: [
				{
					name: "remote-http",
					transport: "http",
					url: "https://example.com/mcp",
					headers: {
						Authorization: "Bearer static",
						"X-Static": "1",
					},
					headersHelper: helperPath,
					env: {
						TOKEN_VALUE: "helper-token",
					},
				},
			],
		});

		const options = httpTransportCtor.mock.calls[0]![1] as
			| { requestInit?: RequestInit }
			| undefined;
		const headers = new Headers(options?.requestInit?.headers);

		expect(headers.get("Authorization")).toBe("Bearer dynamic");
		expect(headers.get("X-Static")).toBe("1");
		expect(headers.get("X-Dynamic")).toBe("helper-token");
		expect(headers.get("X-Server")).toBe("remote-http");
	});

	it("registers an elicitation handler that proxies through the current client tool service", async () => {
		await manager.configure({
			servers: [
				{
					name: "remote-http",
					transport: "http",
					url: "https://example.com/mcp",
				},
			],
		});

		expect(mockSetRequestHandler).toHaveBeenCalledTimes(1);
		expect(clientCtorOptions[0]).toMatchObject({
			capabilities: {
				elicitation: {
					form: { applyDefaults: true },
					url: {},
				},
			},
		});

		const handler = mockSetRequestHandler.mock.calls[0]?.[1] as
			| ((
					request: unknown,
					extra: { requestId: string; signal?: AbortSignal },
			  ) => Promise<unknown>)
			| undefined;
		expect(handler).toBeTypeOf("function");

		const requestExecution = vi.fn().mockResolvedValue({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						action: "accept",
						content: {
							name: "Maestro",
							enabled: true,
							count: 2,
							tags: ["alpha"],
						},
					}),
				},
			],
			isError: false,
		});

		const result = await runWithMcpClientToolService(
			{ requestExecution },
			() =>
				handler?.(
					{
						method: "elicitation/create",
						params: {
							message: "Provide settings",
							requestedSchema: {
								type: "object",
								properties: {
									name: { type: "string" },
								},
							},
						},
					},
					{ requestId: "request-123" },
				) ?? Promise.resolve(undefined),
		);

		expect(requestExecution).toHaveBeenCalledWith(
			"mcp_elicitation:remote-http:request-123",
			"mcp_elicitation",
			{
				serverName: "remote-http",
				requestId: "request-123",
				mode: "form",
				message: "Provide settings",
				requestedSchema: {
					type: "object",
					properties: {
						name: { type: "string" },
					},
				},
			},
			undefined,
		);
		expect(result).toEqual({
			action: "accept",
			content: {
				name: "Maestro",
				enabled: true,
				count: 2,
				tags: ["alpha"],
			},
		});
	});

	it("cancels elicitation requests when no client tool service is available", async () => {
		await manager.configure({
			servers: [
				{
					name: "remote-http",
					transport: "http",
					url: "https://example.com/mcp",
				},
			],
		});

		const handler = mockSetRequestHandler.mock.calls[0]?.[1] as
			| ((request: unknown, extra: { requestId: string }) => Promise<unknown>)
			| undefined;

		await expect(
			handler?.(
				{
					method: "elicitation/create",
					params: {
						mode: "url",
						message: "Authorize",
						url: "https://example.com/authorize",
						elicitationId: "elicit-1",
					},
				},
				{ requestId: "request-456" },
			),
		).resolves.toEqual({ action: "cancel" });
	});
});
