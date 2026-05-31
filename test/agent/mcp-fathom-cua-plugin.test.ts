import { afterEach, describe, expect, it, vi } from "vitest";
import { loadMcpConfig } from "../../src/mcp/config.js";
import { getFathomCuaPluginServers } from "../../src/mcp/fathom-cua.js";

describe("Fathom CUA MCP plugin server", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("stays disabled unless explicitly enabled", () => {
		vi.stubEnv("MAESTRO_FATHOM_CUA_ENABLED", "");
		vi.stubEnv("FATHOM_CUA_MCP_ENABLED", "");

		expect(getFathomCuaPluginServers()).toEqual([]);
	});

	it("builds a stdio fathom-client server from a sibling repo", () => {
		vi.stubEnv("MAESTRO_FATHOM_CUA_ENABLED", "1");
		vi.stubEnv("MAESTRO_FATHOM_CUA_REPO", "/tmp/fathom");
		vi.stubEnv("MAESTRO_FATHOM_CUA_WORKSPACE_ID", "workspace_1");
		vi.stubEnv("MAESTRO_FATHOM_CUA_IPC_ROOT", "/tmp/fathom-ipc");
		vi.stubEnv("MAESTRO_FATHOM_CUA_SESSION_ID", "desktop-session-1");
		vi.stubEnv("MAESTRO_FATHOM_CUA_TURN_ID", "turn-1");

		expect(getFathomCuaPluginServers()).toEqual([
			expect.objectContaining({
				name: "fathom-cua",
				transport: "stdio",
				command: "go",
				cwd: "/tmp/fathom",
				scope: "plugin",
				env: {
					FATHOM_CALLER_PRODUCT: "maestro",
					FATHOM_CUA_PRODUCT: "maestro",
					FATHOM_CUA_WORKSPACE_ID: "workspace_1",
					FATHOM_IPC_ROOT: "/tmp/fathom-ipc",
				},
			}),
		]);
		expect(getFathomCuaPluginServers()[0]?.args).toEqual([
			"run",
			"./cmd/fathom-client",
			"-tool-profile",
			"canonical",
			"-workspace-id",
			"workspace_1",
			"-ipc-root",
			"/tmp/fathom-ipc",
			"-session-id",
			"desktop-session-1",
			"-turn-id",
			"turn-1",
		]);
	});

	it("supports an installed fathom-client command and explicit arguments", () => {
		vi.stubEnv("MAESTRO_FATHOM_CUA_ENABLED", "1");
		vi.stubEnv("MAESTRO_FATHOM_CUA_CLIENT_COMMAND", "/opt/fathom-client");
		vi.stubEnv(
			"MAESTRO_FATHOM_CUA_CLIENT_ARGS_JSON",
			JSON.stringify(["-helper-endpoint", "xpc:test"]),
		);
		vi.stubEnv("MAESTRO_FATHOM_CUA_DISABLE_IPC", "1");

		expect(getFathomCuaPluginServers()[0]).toMatchObject({
			command: "/opt/fathom-client",
			args: [
				"-helper-endpoint",
				"xpc:test",
				"-tool-profile",
				"canonical",
				"-disable-ipc",
			],
		});
	});

	it("allows explicit full profile for debugging and CI parity checks", () => {
		vi.stubEnv("MAESTRO_FATHOM_CUA_ENABLED", "1");
		vi.stubEnv("MAESTRO_FATHOM_CUA_REPO", "/tmp/fathom");
		vi.stubEnv("MAESTRO_FATHOM_CUA_TOOL_PROFILE", "full");

		expect(getFathomCuaPluginServers()[0]?.args).toContain("-tool-profile");
		expect(getFathomCuaPluginServers()[0]?.args).toContain("full");
	});

	it("does not force the auto-detected repo cwd onto custom commands", () => {
		vi.stubEnv("MAESTRO_FATHOM_CUA_ENABLED", "1");
		vi.stubEnv("MAESTRO_FATHOM_CUA_REPO", "/tmp/fathom");
		vi.stubEnv("MAESTRO_FATHOM_CUA_CLIENT_COMMAND", "./bin/fathom-client");

		expect(getFathomCuaPluginServers()[0]).toMatchObject({
			command: "./bin/fathom-client",
			cwd: undefined,
		});
	});

	it("uses an explicit custom command cwd when configured", () => {
		vi.stubEnv("MAESTRO_FATHOM_CUA_ENABLED", "1");
		vi.stubEnv("MAESTRO_FATHOM_CUA_REPO", "/tmp/fathom");
		vi.stubEnv("MAESTRO_FATHOM_CUA_CLIENT_COMMAND", "./bin/fathom-client");
		vi.stubEnv("MAESTRO_FATHOM_CUA_CLIENT_CWD", "/tmp/custom-fathom");

		expect(getFathomCuaPluginServers()[0]).toMatchObject({
			command: "./bin/fathom-client",
			cwd: "/tmp/custom-fathom",
		});
	});

	it("participates in the merged MCP config as plugin scope", () => {
		vi.stubEnv("MAESTRO_FATHOM_CUA_ENABLED", "1");
		vi.stubEnv("MAESTRO_FATHOM_CUA_REPO", "/tmp/fathom");

		const config = loadMcpConfig("/tmp/project");

		expect(
			config.servers.find((server) => server.name === "fathom-cua"),
		).toEqual(
			expect.objectContaining({
				scope: "plugin",
				command: "go",
			}),
		);
	});
});
