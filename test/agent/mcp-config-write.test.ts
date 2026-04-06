import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addMcpServerToConfig,
	getWritableMcpConfigPath,
	inferRemoteMcpTransport,
	removeMcpServerFromConfig,
	updateMcpServerInConfig,
} from "../../src/mcp/config.js";

describe("MCP config writing", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `mcp-config-write-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("infers the remote transport from the URL", () => {
		expect(inferRemoteMcpTransport("https://example.com/mcp")).toBe("http");
		expect(inferRemoteMcpTransport("https://example.com/sse")).toBe("sse");
	});

	it("writes a new local MCP config using mcpServers format", () => {
		const result = addMcpServerToConfig({
			projectRoot: testDir,
			scope: "local",
			server: {
				name: "linear",
				transport: "http",
				url: "https://mcp.linear.app/mcp",
			},
		});

		expect(result.path).toBe(getWritableMcpConfigPath("local", testDir));
		expect(JSON.parse(readFileSync(result.path, "utf-8"))).toEqual({
			mcpServers: {
				linear: {
					transport: "http",
					url: "https://mcp.linear.app/mcp",
				},
			},
		});
	});

	it("appends to an existing mcpServers object", () => {
		const configPath = getWritableMcpConfigPath("project", testDir);
		mkdirSync(join(testDir, ".maestro"), { recursive: true });
		writeFileSync(
			configPath,
			JSON.stringify({
				mcpServers: {
					filesystem: {
						command: "npx",
						args: ["-y", "@modelcontextprotocol/server-filesystem"],
					},
				},
			}),
		);

		addMcpServerToConfig({
			projectRoot: testDir,
			scope: "project",
			server: {
				name: "linear",
				transport: "http",
				url: "https://mcp.linear.app/mcp",
			},
		});

		expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual({
			mcpServers: {
				filesystem: {
					command: "npx",
					args: ["-y", "@modelcontextprotocol/server-filesystem"],
				},
				linear: {
					transport: "http",
					url: "https://mcp.linear.app/mcp",
				},
			},
		});
	});

	it("preserves servers array format when that is already in use", () => {
		const configPath = getWritableMcpConfigPath("project", testDir);
		mkdirSync(join(testDir, ".maestro"), { recursive: true });
		writeFileSync(
			configPath,
			JSON.stringify({
				servers: [
					{
						name: "filesystem",
						transport: "stdio",
						command: "npx",
						args: ["-y", "@modelcontextprotocol/server-filesystem"],
					},
				],
			}),
		);

		addMcpServerToConfig({
			projectRoot: testDir,
			scope: "project",
			server: {
				name: "linear",
				transport: "http",
				url: "https://mcp.linear.app/mcp",
			},
		});

		expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual({
			servers: [
				{
					name: "filesystem",
					transport: "stdio",
					command: "npx",
					args: ["-y", "@modelcontextprotocol/server-filesystem"],
				},
				{
					name: "linear",
					transport: "http",
					url: "https://mcp.linear.app/mcp",
				},
			],
		});
	});

	it("rejects duplicate server names in the same file", () => {
		addMcpServerToConfig({
			projectRoot: testDir,
			scope: "local",
			server: {
				name: "linear",
				transport: "http",
				url: "https://mcp.linear.app/mcp",
			},
		});

		expect(() =>
			addMcpServerToConfig({
				projectRoot: testDir,
				scope: "local",
				server: {
					name: "linear",
					transport: "http",
					url: "https://mcp.linear.app/mcp",
				},
			}),
		).toThrow('MCP server "linear" already exists');
	});

	it("removes a server from an existing mcpServers object", () => {
		const configPath = getWritableMcpConfigPath("project", testDir);
		mkdirSync(join(testDir, ".maestro"), { recursive: true });
		writeFileSync(
			configPath,
			JSON.stringify({
				mcpServers: {
					filesystem: {
						command: "npx",
						args: ["-y", "@modelcontextprotocol/server-filesystem"],
					},
					linear: {
						transport: "http",
						url: "https://mcp.linear.app/mcp",
					},
				},
			}),
		);

		const result = removeMcpServerFromConfig({
			projectRoot: testDir,
			scope: "project",
			name: "linear",
		});

		expect(result).toEqual({
			path: configPath,
			scope: "project",
		});
		expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual({
			mcpServers: {
				filesystem: {
					command: "npx",
					args: ["-y", "@modelcontextprotocol/server-filesystem"],
				},
			},
		});
	});

	it("updates a server in place using the merged writable scope", () => {
		const configPath = getWritableMcpConfigPath("local", testDir);
		mkdirSync(join(testDir, ".maestro"), { recursive: true });
		writeFileSync(
			configPath,
			JSON.stringify({
				mcpServers: {
					linear: {
						transport: "http",
						url: "https://mcp.linear.app/mcp",
					},
				},
			}),
		);

		const result = updateMcpServerInConfig({
			projectRoot: testDir,
			name: "linear",
			server: {
				name: "linear",
				transport: "http",
				url: "https://mcp.linear.app/mcp/v2",
				headers: {
					Authorization: "Bearer token",
				},
			},
		});

		expect(result).toEqual({
			path: configPath,
			scope: "local",
		});
		expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual({
			mcpServers: {
				linear: {
					transport: "http",
					url: "https://mcp.linear.app/mcp/v2",
					headers: {
						Authorization: "Bearer token",
					},
				},
			},
		});
	});
});
