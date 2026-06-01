import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMcpConfig } from "../../src/mcp/config.js";
import type { McpServerConfig } from "../../src/mcp/types.js";

describe("MCP multi-scope precedence and env expansion", () => {
	const ENV_KEYS = [
		"HOME",
		"MAESTRO_HOME",
		"MAESTRO_AGENT_DIR",
		"MAESTRO_ENTERPRISE_MCP_PATH",
		"MAESTRO_USER_MCP_PATH",
		"MAESTRO_PLATFORM_MCP_ENABLED",
		"MAESTRO_AGENT_MCP_ENABLED",
		"MAESTRO_PLATFORM_MCP_URL",
		"MAESTRO_AGENT_MCP_URL",
		"MAESTRO_EVALOPS_AGENT_MCP_URL",
		"MAESTRO_PLATFORM_MCP_TOKEN",
		"MAESTRO_AGENT_MCP_TOKEN",
		"MAESTRO_EVALOPS_ACCESS_TOKEN",
		"EVALOPS_TOKEN",
		"MAESTRO_WORKSPACE_ID",
		"MAESTRO_EVALOPS_WORKSPACE_ID",
		"MAESTRO_EVALOPS_ORG_ID",
		"EVALOPS_ORGANIZATION_ID",
		"MAESTRO_ENTERPRISE_ORG_ID",
		"MAESTRO_AGENT_ID",
		"MAESTRO_EVALOPS_AGENT_ID",
		"MAESTRO_AGENT_RUN_ID",
		"MAESTRO_SESSION_ID",
		"MAESTRO_REQUEST_ID",
		"TRACE_ID",
		"OTEL_TRACE_ID",
		"TEST_FOO",
	] as const;

	let baseDir: string;
	let projectDir: string;
	let previousEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;

	beforeEach(() => {
		previousEnv = Object.fromEntries(
			ENV_KEYS.map((key) => [key, process.env[key]]),
		);
		baseDir = mkdtempSync(join(tmpdir(), "mcp-merge-"));
		projectDir = baseDir;
		mkdirSync(projectDir, { recursive: true });
		for (const key of ENV_KEYS) {
			Reflect.deleteProperty(process.env, key);
		}
		process.env.MAESTRO_PLATFORM_MCP_ENABLED = "false";
		process.env.MAESTRO_AGENT_MCP_ENABLED = "false";
		process.env.MAESTRO_HOME = join(baseDir, "home");
		process.env.MAESTRO_AGENT_DIR = join(baseDir, "agent");
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			const value = previousEnv[key];
			if (value === undefined) {
				Reflect.deleteProperty(process.env, key);
			} else {
				process.env[key] = value;
			}
		}
		rmSync(baseDir, { recursive: true, force: true });
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
		write(join(projectDir, ".maestro/mcp.local.json"), {
			servers: [{ name: "svc", transport: "stdio", command: "local-cmd" }],
		});
		// project
		write(join(projectDir, ".maestro/mcp.json"), {
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
		process.env.MAESTRO_ENTERPRISE_MCP_PATH = join(baseDir, "enterprise.json");
		process.env.MAESTRO_USER_MCP_PATH = join(baseDir, "user.json");

		const cfg = loadMcpConfig(projectDir, {
			pluginServers,
			includeEnvLimits: true,
		});

		expect(cfg.servers).toHaveLength(1);
		expect(cfg.servers[0]!.command).toBe("enterprise-cmd");
	});

	it("allows higher-precedence configs to disable servers from lower-precedence", () => {
		// user enables
		write(join(baseDir, "user.json"), {
			servers: [{ name: "svc", transport: "stdio", command: "user-cmd" }],
		});
		// enterprise disables
		write(join(baseDir, "enterprise.json"), {
			servers: [
				{
					name: "svc",
					transport: "stdio",
					command: "noop",
					disabled: true,
				},
			],
		});

		process.env.MAESTRO_ENTERPRISE_MCP_PATH = join(baseDir, "enterprise.json");
		process.env.MAESTRO_USER_MCP_PATH = join(baseDir, "user.json");

		const cfg = loadMcpConfig(projectDir, { includeEnvLimits: true });
		expect(cfg.servers).toHaveLength(0);
	});

	it("ignores default directory candidates when selecting the effective user MCP config path", () => {
		const previousHome = process.env.HOME;
		const previousMaestroHome = process.env.MAESTRO_HOME;
		const previousUserMcpPath = process.env.MAESTRO_USER_MCP_PATH;
		try {
			process.env.HOME = baseDir;
			Reflect.deleteProperty(process.env, "MAESTRO_HOME");
			Reflect.deleteProperty(process.env, "MAESTRO_USER_MCP_PATH");
			mkdirSync(join(baseDir, ".maestro", "mcp.json"), {
				recursive: true,
			});
			write(join(baseDir, ".composer", "mcp.json"), {
				servers: [
					{
						name: "svc",
						transport: "stdio",
						command: "legacy-user-cmd",
					},
				],
			});

			const cfg = loadMcpConfig(projectDir, { includeEnvLimits: true });

			expect(cfg.servers).toHaveLength(1);
			expect(cfg.servers[0]!.command).toBe("legacy-user-cmd");
		} finally {
			if (previousHome === undefined) {
				Reflect.deleteProperty(process.env, "HOME");
			} else {
				process.env.HOME = previousHome;
			}
			if (previousMaestroHome === undefined) {
				Reflect.deleteProperty(process.env, "MAESTRO_HOME");
			} else {
				process.env.MAESTRO_HOME = previousMaestroHome;
			}
			if (previousUserMcpPath === undefined) {
				Reflect.deleteProperty(process.env, "MAESTRO_USER_MCP_PATH");
			} else {
				process.env.MAESTRO_USER_MCP_PATH = previousUserMcpPath;
			}
		}
	});

	it("does not fall back to legacy enterprise MCP config when an env path is explicit", () => {
		const previousHome = process.env.HOME;
		const previousEnterpriseMcpPath = process.env.MAESTRO_ENTERPRISE_MCP_PATH;
		try {
			process.env.HOME = baseDir;
			process.env.MAESTRO_ENTERPRISE_MCP_PATH = join(
				baseDir,
				"managed",
				"enterprise-mcp.json",
			);
			write(join(baseDir, ".composer", "enterprise", "mcp.json"), {
				servers: [
					{
						name: "svc",
						transport: "stdio",
						command: "legacy-enterprise-cmd",
					},
				],
			});

			const cfg = loadMcpConfig(projectDir, { includeEnvLimits: true });

			expect(cfg.servers).toHaveLength(0);
		} finally {
			if (previousHome === undefined) {
				Reflect.deleteProperty(process.env, "HOME");
			} else {
				process.env.HOME = previousHome;
			}
			if (previousEnterpriseMcpPath === undefined) {
				Reflect.deleteProperty(process.env, "MAESTRO_ENTERPRISE_MCP_PATH");
			} else {
				process.env.MAESTRO_ENTERPRISE_MCP_PATH = previousEnterpriseMcpPath;
			}
		}
	});

	it("expands ${VAR} and ${VAR:-fallback}", () => {
		process.env.TEST_FOO = "hello";
		write(join(projectDir, ".maestro/mcp.json"), {
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
		const server = cfg.servers[0]!;
		expect(server.args).toEqual(["hello", "fallback"]);
	});

	it("detects sse URLs heuristically", () => {
		write(join(projectDir, ".maestro/mcp.json"), {
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
