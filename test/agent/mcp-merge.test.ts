import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMcpConfig } from "../../src/mcp/config.js";
import type { McpServerConfig } from "../../src/mcp/types.js";

describe("MCP multi-scope precedence and env expansion", () => {
	let baseDir: string;
	let projectDir: string;

	beforeEach(() => {
		baseDir = join(tmpdir(), `mcp-merge-${Date.now()}`);
		projectDir = baseDir;
		mkdirSync(projectDir, { recursive: true });
		process.env.COMPOSER_ENTERPRISE_MCP_PATH = undefined;
		process.env.COMPOSER_USER_MCP_PATH = undefined;
	});

	afterEach(() => {
		// leave temp dirs; OS will clean
	});

	function write(path: string, data: unknown) {
		mkdirSync(resolve(path, ".."), { recursive: true });
		writeFileSync(path, JSON.stringify(data, null, 2));
	}

	it("applies precedence enterprise -> plugin -> project -> local -> user", () => {
		// user
		write(join(baseDir, "user.json"), {
			servers: [{ name: "svc", transport: "stdio", command: "user-cmd" }],
		});
		// local
		write(join(projectDir, ".composer/mcp.local.json"), {
			servers: [{ name: "svc", transport: "stdio", command: "local-cmd" }],
		});
		// project
		write(join(projectDir, ".composer/mcp.json"), {
			servers: [{ name: "svc", transport: "stdio", command: "project-cmd" }],
		});
		// enterprise
		write(join(baseDir, "enterprise.json"), {
			servers: [{ name: "svc", transport: "stdio", command: "enterprise-cmd" }],
		});

		const pluginServers: McpServerConfig[] = [
			{ name: "svc", transport: "stdio", command: "plugin-cmd" },
		];

		// Patch paths via env for test
		process.env.COMPOSER_ENTERPRISE_MCP_PATH = join(baseDir, "enterprise.json");
		process.env.COMPOSER_USER_MCP_PATH = join(baseDir, "user.json");

		const cfg = loadMcpConfig(projectDir, {
			pluginServers,
			includeEnvLimits: true,
		});

		expect(cfg.servers).toHaveLength(1);
		expect(cfg.servers[0].command).toBe("enterprise-cmd");
	});

	it("expands ${VAR} and ${VAR:-fallback}", () => {
		process.env.TEST_FOO = "hello";
		write(join(projectDir, ".composer/mcp.json"), {
			servers: [
				{
					name: "exp",
					transport: "stdio",
					command: "echo",
					args: ["${TEST_FOO}", "${MISSING:-fallback}"],
				},
			],
		});

		const cfg = loadMcpConfig(projectDir, { includeEnvLimits: true });
		const server = cfg.servers[0];
		expect(server.args).toEqual(["hello", "fallback"]);
	});

	it("detects sse URLs heuristically", () => {
		write(join(projectDir, ".composer/mcp.json"), {
			servers: [
				{ name: "a", url: "http://example.com/sse" },
				{ name: "b", url: "http://sse.example.com/stream" },
				{ name: "c", url: "http://example.com/api" },
			],
		});
		const cfg = loadMcpConfig(projectDir, { includeEnvLimits: true });
		const transports = Object.fromEntries(
			cfg.servers.map((s) => [s.name, s.transport]),
		);
		expect(transports).toEqual({ a: "sse", b: "sse", c: "http" });
	});
});
