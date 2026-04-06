import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockClientConnect = vi.fn();
const mockClientClose = vi.fn();
const mockSetNotificationHandler = vi.fn();
const sseTransportCtor = vi.fn();
const httpTransportCtor = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: class MockClient {
		connect = mockClientConnect.mockResolvedValue(undefined);
		getServerCapabilities = vi.fn(() => ({
			tools: {},
			resources: {},
			prompts: {},
		}));
		listTools = vi.fn().mockResolvedValue({ tools: [] });
		listResources = vi.fn().mockResolvedValue({ resources: [] });
		listPrompts = vi.fn().mockResolvedValue({ prompts: [] });
		setNotificationHandler = mockSetNotificationHandler;
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
		sseTransportCtor.mockClear();
		httpTransportCtor.mockClear();
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
});
