import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithMcpClientToolService } from "../../src/mcp/elicitation.js";
import { resolveMcpWorkspaceUri } from "../../src/mcp/workspace-trust.js";

const mockClientConnect = vi.fn();
const mockClientClose = vi.fn();
const mockCallTool = vi.fn();
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
		callTool = mockCallTool.mockResolvedValue({
			content: [{ type: "text", text: "ok" }],
			isError: false,
		});
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
		vi.stubEnv(
			"MAESTRO_MCP_WORKSPACE_TRUST_FILE",
			join(tempDir, "workspace-trust.json"),
		);
		mockClientConnect.mockClear();
		mockClientClose.mockClear();
		mockCallTool.mockClear();
		mockSetNotificationHandler.mockClear();
		mockSetRequestHandler.mockClear();
		mockListPrompts.mockReset().mockResolvedValue({ prompts: [] });
		sseTransportCtor.mockClear();
		httpTransportCtor.mockClear();
		clientCtorOptions.length = 0;
	});

	afterEach(async () => {
		await manager.disconnectAll();
		vi.unstubAllEnvs();
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

	it("reconnects unchanged configured servers after disconnectAll", async () => {
		const config = {
			servers: [
				{
					name: "remote-http",
					transport: "http" as const,
					url: "https://example.com/mcp",
				},
			],
		};

		await manager.configure(config);
		expect(manager.isConnected("remote-http")).toBe(true);

		await manager.disconnectAll();
		expect(manager.isConnected("remote-http")).toBe(false);

		await manager.configure(config);

		expect(httpTransportCtor).toHaveBeenCalledTimes(2);
		expect(manager.isConnected("remote-http")).toBe(true);
	});

	it("emits sparse MCP connection and tool usage beacons", async () => {
		vi.stubEnv("MAESTRO_TELEMETRY", "1");
		vi.stubEnv("MAESTRO_BEACON_FILE", join(tempDir, "beacon.jsonl"));
		vi.stubEnv("MAESTRO_VERSION", "0.10.18-test");

		await manager.configure({
			servers: [
				{
					name: "remote-http",
					transport: "http",
					url: "https://example.com/mcp?token=secret",
				},
			],
		});
		await waitForBeaconEvents(1, process.env.MAESTRO_BEACON_FILE!);

		await manager.callTool("remote-http", "search", {
			query: "do not collect this",
		});
		const events = await waitForBeaconEvents(
			2,
			process.env.MAESTRO_BEACON_FILE!,
		);

		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					feature: "mcp.connection",
					action: "remoteConnected",
					parameters: {
						metadata: expect.objectContaining({
							serverName: "remote-http",
							transport: "http",
							remoteHost: "example.com",
							toolCount: 0,
							resourceCount: 0,
							promptCount: 0,
						}),
					},
				}),
				expect.objectContaining({
					feature: "mcp.toolUsage",
					action: "remoteToolCalled",
					parameters: {
						metadata: {
							serverName: "remote-http",
							transport: "http",
							remoteHost: "example.com",
							toolName: "search",
						},
					},
				}),
			]),
		);
		for (const event of events) {
			expect(event.parameters.metadata).not.toHaveProperty("url");
			expect(event.parameters.metadata).not.toHaveProperty("args");
			expect(event.parameters.metadata).not.toHaveProperty("query");
			expect(event.parameters.metadata).not.toHaveProperty("content");
		}
	});

	it("routes untrusted workspace MCP tool calls through MCP elicitation", async () => {
		const requestExecution = vi.fn().mockResolvedValue({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						action: "accept",
						content: { decision: "trust_once" },
					}),
				},
			],
			isError: false,
		});

		await manager.configure({
			workspaceTrustDefault: "ask",
			projectRoot: tempDir,
			servers: [
				{
					name: "remote-http",
					transport: "http",
					url: "https://example.com/mcp",
				},
			],
			authPresets: [],
		});

		const result = await runWithMcpClientToolService({ requestExecution }, () =>
			manager.callTool("remote-http", "search", { query: "docs" }),
		);

		expect(requestExecution).toHaveBeenCalledTimes(1);
		expect(requestExecution.mock.calls[0]?.[1]).toBe("mcp_elicitation");
		expect(requestExecution.mock.calls[0]?.[2]).toMatchObject({
			serverName: "remote-http",
			mode: "form",
			requestedSchema: {
				properties: {
					decision: {
						enum: ["trust_once", "trust_always", "block", "cancel"],
					},
				},
			},
		});
		expect(mockCallTool).toHaveBeenCalledWith({
			name: "search",
			arguments: { query: "docs" },
		});
		expect(result.content).toEqual([{ type: "text", text: "ok" }]);
	});

	it("does not invoke MCP tools when workspace trust is denied", async () => {
		const requestExecution = vi.fn().mockResolvedValue({
			content: [
				{
					type: "text",
					text: JSON.stringify({ action: "cancel" }),
				},
			],
			isError: false,
		});

		await manager.configure({
			workspaceTrustDefault: "ask",
			projectRoot: tempDir,
			servers: [
				{
					name: "remote-http",
					transport: "http",
					url: "https://example.com/mcp",
				},
			],
			authPresets: [],
		});

		await expect(
			runWithMcpClientToolService({ requestExecution }, () =>
				manager.callTool("remote-http", "search", { query: "docs" }),
			),
		).rejects.toThrow("was not trusted");

		expect(requestExecution).toHaveBeenCalledTimes(1);
		expect(mockCallTool).not.toHaveBeenCalled();
	});

	it("honors legacy blocked trust entries without server fingerprints", async () => {
		writeFileSync(
			join(tempDir, "workspace-trust.json"),
			JSON.stringify({
				version: 1,
				servers: {
					"remote-http": [
						{
							workspaceUri: `file:${tempDir}`,
							mode: "blocked",
							grantedBy: "user",
							grantedAt: "2026-05-07T00:00:00.000Z",
						},
					],
				},
			}),
		);

		await manager.configure({
			projectRoot: tempDir,
			servers: [
				{
					name: "remote-http",
					transport: "http",
					url: "https://example.com/mcp",
				},
			],
			authPresets: [],
		});

		await expect(
			manager.callTool("remote-http", "search", { query: "docs" }),
		).rejects.toThrow("is not trusted");
		expect(mockCallTool).not.toHaveBeenCalled();
	});

	it("blocks ask-mode MCP calls when no MCP elicitation client is connected", async () => {
		await manager.configure({
			workspaceTrustDefault: "ask",
			projectRoot: tempDir,
			servers: [
				{
					name: "remote-http",
					transport: "http",
					url: "https://example.com/mcp",
				},
			],
			authPresets: [],
		});

		await expect(
			manager.callTool("remote-http", "search", { query: "docs" }),
		).rejects.toThrow("no MCP elicitation client is connected");
		expect(mockCallTool).not.toHaveBeenCalled();
	});

	it("enforces configured workspace trust over stale stored trust", async () => {
		const requestExecution = vi.fn().mockResolvedValue({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						action: "accept",
						content: { decision: "trust_always" },
					}),
				},
			],
			isError: false,
		});
		const server = {
			name: "remote-http",
			transport: "http" as const,
			url: "https://example.com/mcp",
		};

		await manager.configure({
			workspaceTrustDefault: "ask",
			projectRoot: tempDir,
			servers: [server],
			authPresets: [],
		});
		await runWithMcpClientToolService({ requestExecution }, () =>
			manager.callTool("remote-http", "search", { query: "docs" }),
		);
		expect(mockCallTool).toHaveBeenCalledTimes(1);

		mockCallTool.mockClear();
		await manager.configure({
			workspaceTrustDefault: "ask",
			projectRoot: tempDir,
			trustedWorkspaces: {
				"remote-http": [
					{
						workspaceUri: `file:${tempDir}`,
						mode: "blocked",
						grantedBy: "admin",
						grantedAt: "2026-05-07T00:00:00.000Z",
						reason: "Revoked by policy",
					},
				],
			},
			servers: [server],
			authPresets: [],
		});

		await expect(
			runWithMcpClientToolService({ requestExecution }, () =>
				manager.callTool("remote-http", "search", { query: "docs" }),
			),
		).rejects.toThrow("is not trusted");
		expect(mockCallTool).not.toHaveBeenCalled();
	});

	it("reprompts when a stored trust decision belongs to a different server definition", async () => {
		const requestExecution = vi.fn().mockResolvedValue({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						action: "accept",
						content: { decision: "trust_always" },
					}),
				},
			],
			isError: false,
		});

		await manager.configure({
			workspaceTrustDefault: "ask",
			projectRoot: tempDir,
			servers: [
				{
					name: "remote-http",
					transport: "http",
					url: "https://example.com/mcp",
				},
			],
			authPresets: [],
		});
		await runWithMcpClientToolService({ requestExecution }, () =>
			manager.callTool("remote-http", "search", { query: "docs" }),
		);

		mockCallTool.mockClear();
		requestExecution.mockClear().mockResolvedValue({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						action: "accept",
						content: { decision: "trust_always" },
					}),
				},
			],
			isError: false,
		});

		await manager.configure({
			workspaceTrustDefault: "ask",
			projectRoot: tempDir,
			servers: [
				{
					name: "remote-http",
					transport: "http",
					url: "https://different.example.com/mcp",
				},
			],
			authPresets: [],
		});
		await runWithMcpClientToolService({ requestExecution }, () =>
			manager.callTool("remote-http", "search", { query: "docs" }),
		);

		expect(requestExecution).toHaveBeenCalledTimes(1);
		expect(mockCallTool).toHaveBeenCalledWith({
			name: "search",
			arguments: { query: "docs" },
		});

		const trustStore = JSON.parse(
			readFileSync(join(tempDir, "workspace-trust.json"), "utf8"),
		) as {
			servers: Record<string, Array<{ serverFingerprint?: string }>>;
		};
		const entries = trustStore.servers["remote-http"] ?? [];
		expect(entries).toHaveLength(2);
		expect(new Set(entries.map((entry) => entry.serverFingerprint)).size).toBe(
			2,
		);

		mockCallTool.mockClear();
		requestExecution.mockClear();
		await manager.configure({
			workspaceTrustDefault: "ask",
			projectRoot: tempDir,
			servers: [
				{
					name: "remote-http",
					transport: "http",
					url: "https://example.com/mcp",
				},
			],
			authPresets: [],
		});
		await runWithMcpClientToolService({ requestExecution }, () =>
			manager.callTool("remote-http", "search", { query: "docs" }),
		);

		expect(requestExecution).not.toHaveBeenCalled();
		expect(mockCallTool).toHaveBeenCalledWith({
			name: "search",
			arguments: { query: "docs" },
		});
	});

	it("reprompts when a stored trust decision belongs to changed auth preset contents", async () => {
		const requestExecution = vi.fn().mockResolvedValue({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						action: "accept",
						content: { decision: "trust_always" },
					}),
				},
			],
			isError: false,
		});
		const server = {
			name: "remote-http",
			transport: "http" as const,
			url: "https://example.com/mcp",
			authPreset: "prod",
		};

		await manager.configure({
			workspaceTrustDefault: "ask",
			projectRoot: tempDir,
			servers: [server],
			authPresets: [
				{
					name: "prod",
					headers: { Authorization: "Bearer first" },
				},
			],
		});
		await runWithMcpClientToolService({ requestExecution }, () =>
			manager.callTool("remote-http", "search", { query: "docs" }),
		);

		mockCallTool.mockClear();
		requestExecution.mockClear().mockResolvedValue({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						action: "accept",
						content: { decision: "trust_once" },
					}),
				},
			],
			isError: false,
		});

		await manager.configure({
			workspaceTrustDefault: "ask",
			projectRoot: tempDir,
			servers: [server],
			authPresets: [
				{
					name: "prod",
					headers: { Authorization: "Bearer second" },
				},
			],
		});
		await runWithMcpClientToolService({ requestExecution }, () =>
			manager.callTool("remote-http", "search", { query: "docs" }),
		);

		expect(requestExecution).toHaveBeenCalledTimes(1);
		expect(mockCallTool).toHaveBeenCalledWith({
			name: "search",
			arguments: { query: "docs" },
		});
	});

	it("keeps stored trust when only server metadata changes", async () => {
		const requestExecution = vi.fn().mockResolvedValue({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						action: "accept",
						content: { decision: "trust_always" },
					}),
				},
			],
			isError: false,
		});
		const server = {
			name: "remote-http",
			transport: "http" as const,
			url: "https://example.com/mcp",
		};

		await manager.configure({
			workspaceTrustDefault: "ask",
			projectRoot: tempDir,
			servers: [{ ...server, scope: "user", enabled: true }],
			authPresets: [],
		});
		await runWithMcpClientToolService({ requestExecution }, () =>
			manager.callTool("remote-http", "search", { query: "docs" }),
		);

		mockCallTool.mockClear();
		requestExecution.mockClear();
		await manager.configure({
			workspaceTrustDefault: "ask",
			projectRoot: tempDir,
			servers: [{ ...server, scope: "enterprise", disabled: false }],
			authPresets: [],
		});
		await runWithMcpClientToolService({ requestExecution }, () =>
			manager.callTool("remote-http", "search", { query: "docs" }),
		);

		expect(requestExecution).not.toHaveBeenCalled();
		expect(mockCallTool).toHaveBeenCalledWith({
			name: "search",
			arguments: { query: "docs" },
		});
	});

	it("keeps trustedWorkspaces entries scoped to their server", async () => {
		const requestExecution = vi.fn();

		await manager.configure({
			projectRoot: tempDir,
			trustedWorkspaces: {
				linear: [
					{
						workspaceUri: `file:${tempDir}`,
						mode: "trusted",
						grantedBy: "admin",
						grantedAt: "2026-05-07T00:00:00.000Z",
					},
				],
			},
			servers: [
				{
					name: "remote-http",
					transport: "http",
					url: "https://example.com/mcp",
				},
			],
			authPresets: [],
		});

		await runWithMcpClientToolService({ requestExecution }, () =>
			manager.callTool("remote-http", "search", { query: "docs" }),
		);

		expect(requestExecution).not.toHaveBeenCalled();
		expect(mockCallTool).toHaveBeenCalledWith({
			name: "search",
			arguments: { query: "docs" },
		});
	});

	it("expires malformed workspace trust timestamps", async () => {
		const requestExecution = vi.fn().mockResolvedValue({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						action: "accept",
						content: { decision: "trust_once" },
					}),
				},
			],
			isError: false,
		});

		await manager.configure({
			workspaceTrustDefault: "ask",
			projectRoot: tempDir,
			trustedWorkspaces: {
				"remote-http": [
					{
						workspaceUri: `file:${tempDir}`,
						mode: "trusted",
						expiresAt: "not-a-date",
					},
				],
			},
			servers: [
				{
					name: "remote-http",
					transport: "http",
					url: "https://example.com/mcp",
				},
			],
			authPresets: [],
		});

		await runWithMcpClientToolService({ requestExecution }, () =>
			manager.callTool("remote-http", "search", { query: "docs" }),
		);

		expect(requestExecution).toHaveBeenCalledTimes(1);
		expect(mockCallTool).toHaveBeenCalledWith({
			name: "search",
			arguments: { query: "docs" },
		});
	});

	it("canonicalizes configured git workspace URIs before matching policy", async () => {
		const repoDir = join(tempDir, "canonical-policy");
		mkdirSync(repoDir, { recursive: true });
		execFileSync("git", ["-C", repoDir, "init"], { stdio: "ignore" });
		execFileSync(
			"git",
			[
				"-C",
				repoDir,
				"remote",
				"add",
				"origin",
				"git@github.com:acme/private-repo.git",
			],
			{ stdio: "ignore" },
		);

		await manager.configure({
			workspaceTrustDefault: "trusted",
			projectRoot: repoDir,
			trustedWorkspaces: {
				"remote-http": [
					{
						workspaceUri: "git:git@github.com:acme/private-repo.git",
						mode: "blocked",
					},
				],
			},
			servers: [
				{
					name: "remote-http",
					transport: "http",
					url: "https://example.com/mcp",
				},
			],
			authPresets: [],
		});

		await expect(
			manager.callTool("remote-http", "search", { query: "docs" }),
		).rejects.toThrow("is not trusted");
		expect(mockCallTool).not.toHaveBeenCalled();
	});

	it("strips credentials from git remote workspace URIs", async () => {
		const repoDir = join(tempDir, "credentialed-remote");
		mkdirSync(repoDir, { recursive: true });
		execFileSync("git", ["-C", repoDir, "init"], { stdio: "ignore" });
		execFileSync(
			"git",
			[
				"-C",
				repoDir,
				"remote",
				"add",
				"origin",
				"https://token:secret@github.com/acme/private-repo.git?access_token=abc#frag",
			],
			{ stdio: "ignore" },
		);

		await expect(resolveMcpWorkspaceUri(repoDir)).resolves.toBe(
			"git:https://github.com/acme/private-repo.git",
		);
	});

	it("strips userinfo and secrets from scp-style git remote workspace URIs", async () => {
		const repoDir = join(tempDir, "scp-credentialed-remote");
		mkdirSync(repoDir, { recursive: true });
		execFileSync("git", ["-C", repoDir, "init"], { stdio: "ignore" });
		execFileSync(
			"git",
			[
				"-C",
				repoDir,
				"remote",
				"add",
				"origin",
				"token@github.com:acme/private-repo.git?access_token=abc#frag",
			],
			{ stdio: "ignore" },
		);

		await expect(resolveMcpWorkspaceUri(repoDir)).resolves.toBe(
			"git:github.com:acme/private-repo.git",
		);
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

async function waitForBeaconEvents(
	count: number,
	file: string,
): Promise<
	Array<{
		feature: string;
		action: string;
		parameters: { metadata: Record<string, unknown> };
	}>
> {
	const deadline = Date.now() + 1000;
	while (Date.now() < deadline) {
		if (existsSync(file)) {
			const events = readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.flatMap((line) => JSON.parse(line));
			if (events.length >= count) {
				return events;
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return existsSync(file)
		? readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.flatMap((line) => JSON.parse(line))
		: [];
}
