import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMcpConfig } from "../src/mcp/config.js";
import { McpClientManager } from "../src/mcp/manager.js";

describe("MCP config loader", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `mcp-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("returns empty servers when no config exists", () => {
		const config = loadMcpConfig(testDir);
		expect(config.servers).toEqual([]);
	});

	it("loads servers from project config (array format)", () => {
		const configDir = join(testDir, ".composer");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "mcp.json"),
			JSON.stringify({
				servers: [
					{
						name: "test-server",
						transport: "stdio",
						command: "node",
						args: ["server.js"],
					},
				],
			}),
		);

		const config = loadMcpConfig(testDir);
		expect(config.servers).toHaveLength(1);
		expect(config.servers[0].name).toBe("test-server");
		expect(config.servers[0].command).toBe("node");
	});

	it("loads servers from mcpServers format (Claude Desktop style)", () => {
		const configDir = join(testDir, ".composer");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					"my-server": {
						command: "npx",
						args: ["-y", "@example/mcp-server"],
					},
				},
			}),
		);

		const config = loadMcpConfig(testDir);
		expect(config.servers).toHaveLength(1);
		expect(config.servers[0].name).toBe("my-server");
		expect(config.servers[0].command).toBe("npx");
		expect(config.servers[0].args).toEqual(["-y", "@example/mcp-server"]);
	});

	it("excludes disabled servers", () => {
		const configDir = join(testDir, ".composer");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					enabled: { command: "node", args: [] },
					disabled: { command: "node", args: [], disabled: true },
				},
			}),
		);

		const config = loadMcpConfig(testDir);
		expect(config.servers).toHaveLength(1);
		expect(config.servers[0].name).toBe("enabled");
	});

	it("detects http transport from url", () => {
		const configDir = join(testDir, ".composer");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					remote: { url: "http://localhost:3000/mcp" },
				},
			}),
		);

		const config = loadMcpConfig(testDir);
		expect(config.servers).toHaveLength(1);
		expect(config.servers[0].transport).toBe("http");
	});

	it("detects SSE transport when URL ends with /sse", () => {
		const configDir = join(testDir, ".composer");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					"sse-server": { url: "http://localhost:3000/sse" },
				},
			}),
		);

		const config = loadMcpConfig(testDir);
		expect(config.servers).toHaveLength(1);
		expect(config.servers[0].transport).toBe("sse");
	});

	it("detects SSE transport when URL contains /sse/ path segment", () => {
		const configDir = join(testDir, ".composer");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					"sse-server": { url: "http://localhost:3000/sse/connect" },
				},
			}),
		);

		const config = loadMcpConfig(testDir);
		expect(config.servers[0].transport).toBe("sse");
	});

	it("does NOT detect SSE for URLs with 'sse' in other positions (e.g., /sessions)", () => {
		const configDir = join(testDir, ".composer");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					"not-sse": { url: "http://api.example.com/user/sessions" },
				},
			}),
		);

		const config = loadMcpConfig(testDir);
		expect(config.servers).toHaveLength(1);
		expect(config.servers[0].transport).toBe("http");
	});

	it("detects SSE transport for sse subdomain", () => {
		const configDir = join(testDir, ".composer");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					"sse-subdomain": { url: "http://sse.example.com/events" },
				},
			}),
		);

		const config = loadMcpConfig(testDir);
		expect(config.servers[0].transport).toBe("sse");
	});

	it("rejects invalid server configs (stdio without command)", () => {
		const configDir = join(testDir, ".composer");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					invalid: { transport: "stdio" },
				},
			}),
		);

		const config = loadMcpConfig(testDir);
		expect(config.servers).toHaveLength(0);
	});

	it("rejects invalid server configs (http without url)", () => {
		const configDir = join(testDir, ".composer");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "mcp.json"),
			JSON.stringify({
				servers: [{ name: "invalid", transport: "http" }],
			}),
		);

		const config = loadMcpConfig(testDir);
		expect(config.servers).toHaveLength(0);
	});
});

describe("MCP client manager", () => {
	it("initializes with empty config", () => {
		const manager = new McpClientManager();
		const status = manager.getStatus();
		expect(status.servers).toEqual([]);
	});

	it("tracks configured servers in status", async () => {
		const manager = new McpClientManager();
		await manager.configure({
			servers: [
				{ name: "test", transport: "stdio", command: "nonexistent-cmd" },
			],
		});

		const status = manager.getStatus();
		expect(status.servers).toHaveLength(1);
		expect(status.servers[0].name).toBe("test");
		expect(status.servers[0].connected).toBe(false);
	});

	it("clears reconnect timers on disconnectAll", async () => {
		const manager = new McpClientManager();

		await manager.configure({
			servers: [
				{ name: "test", transport: "stdio", command: "nonexistent-cmd" },
			],
		});

		// Wait for connection attempt and potential reconnect scheduling
		await new Promise((resolve) => setTimeout(resolve, 200));

		await manager.disconnectAll();

		// After disconnectAll, no servers should be connected
		expect(manager.isConnected("test")).toBe(false);

		// Reconfiguring with empty should work without errors (timers were cleaned up)
		await manager.configure({ servers: [] });
		const status = manager.getStatus();
		expect(status.servers).toHaveLength(0);
	});

	it("removes servers that are no longer in config on reconfigure", async () => {
		const manager = new McpClientManager();

		await manager.configure({
			servers: [
				{ name: "server1", transport: "stdio", command: "cmd1" },
				{ name: "server2", transport: "stdio", command: "cmd2" },
			],
		});

		let status = manager.getStatus();
		expect(status.servers).toHaveLength(2);

		// Reconfigure with only server1
		await manager.configure({
			servers: [{ name: "server1", transport: "stdio", command: "cmd1" }],
		});

		status = manager.getStatus();
		expect(status.servers).toHaveLength(1);
		expect(status.servers[0].name).toBe("server1");
	});

	it("emits error event on connection failure", async () => {
		const manager = new McpClientManager();
		const errorHandler = vi.fn();
		manager.on("error", errorHandler);

		await manager.configure({
			servers: [
				{ name: "failing", transport: "stdio", command: "nonexistent-cmd" },
			],
		});

		// Wait for connection attempt
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(errorHandler).toHaveBeenCalled();
		expect(errorHandler.mock.calls[0][0].name).toBe("failing");
	});

	it("getAllTools returns empty array when no servers connected", () => {
		const manager = new McpClientManager();
		const tools = manager.getAllTools();
		expect(tools).toEqual([]);
	});

	it("isConnected returns false for unknown server", () => {
		const manager = new McpClientManager();
		expect(manager.isConnected("unknown")).toBe(false);
	});

	it("getServer returns undefined for unknown server", () => {
		const manager = new McpClientManager();
		expect(manager.getServer("unknown")).toBeUndefined();
	});
});
