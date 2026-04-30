import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/composers/index.js", () => ({
	composerManager: {
		getState: vi.fn(() => ({ active: null })),
	},
}));

vi.mock("../../src/mcp/index.js", () => ({
	mcpManager: {
		getStatus: vi.fn(() => ({ servers: [] })),
	},
}));

vi.mock("../../src/safety/safe-mode.js", () => ({
	isSafeModeEnabled: vi.fn(() => false),
}));

vi.mock("../../src/tools/background-tasks.js", () => ({
	backgroundTaskManager: {
		getTasks: vi.fn(() => []),
	},
}));

vi.mock("../../src/cli-tui/utils/env-detect.js", () => ({
	isBubblewrapEnv: vi.fn(() => false),
	isDockerEnv: vi.fn(() => false),
	isFlatpakEnv: vi.fn(() => false),
	isJetBrainsTerminal: vi.fn(() => false),
	isMuslEnv: vi.fn(() => false),
	isPodmanEnv: vi.fn(() => false),
	isScreenEnv: vi.fn(() => false),
	isSshEnv: vi.fn(() => false),
	isTmuxEnv: vi.fn(() => false),
	isWslEnv: vi.fn(() => false),
}));

import {
	buildEnterpriseRuntimeBadges,
	buildRuntimeBadges,
} from "../../src/cli-tui/utils/runtime-badges.js";
import { mcpManager } from "../../src/mcp/index.js";

function createBadgeParams() {
	return {
		approvalMode: null,
		promptQueueMode: "all" as const,
		queuedPromptCount: 0,
		hasPromptQueue: false,
		thinkingLevel: null,
		sandboxMode: null,
		isSafeMode: false,
		sandboxRequestedButMissing: false,
		alertCount: 0,
		reducedMotion: false,
		compactForced: false,
	};
}

describe("buildRuntimeBadges", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(mcpManager.getStatus).mockReturnValue({ servers: [] });
	});

	it("shows connected MCP servers with tool counts", () => {
		vi.mocked(mcpManager.getStatus).mockReturnValueOnce({
			servers: [
				{
					name: "filesystem",
					connected: true,
					transport: "stdio",
					tools: [{ name: "read_file" }, { name: "write_file" }],
					resources: [],
					prompts: [],
				},
			],
		});

		const badges = buildRuntimeBadges(createBadgeParams());

		expect(badges).toContain("mcp:1(2)");
	});

	it("shows MCP failures even when no servers are connected", () => {
		vi.mocked(mcpManager.getStatus).mockReturnValueOnce({
			servers: [
				{
					name: "remote",
					connected: false,
					transport: "http",
					error: "Connection refused",
					tools: [],
					resources: [],
					prompts: [],
				},
			],
		});

		const badges = buildRuntimeBadges(createBadgeParams());

		expect(badges).toContain("mcp:0!1");
	});

	it("appends failure counts when connected and failed servers coexist", () => {
		vi.mocked(mcpManager.getStatus).mockReturnValueOnce({
			servers: [
				{
					name: "filesystem",
					connected: true,
					transport: "stdio",
					tools: [{ name: "read_file" }],
					resources: [],
					prompts: [],
				},
				{
					name: "remote",
					connected: false,
					transport: "http",
					error: "Connection refused",
					tools: [],
					resources: [],
					prompts: [],
				},
			],
		});

		const badges = buildRuntimeBadges(createBadgeParams());

		expect(badges).toContain("mcp:1(1)!1");
	});

	it("shows enterprise mode, policy, and MCP badges when configured", () => {
		const badges = buildRuntimeBadges({
			...createBadgeParams(),
			enterpriseMode: true,
			enterprisePolicyActive: true,
			enterpriseMcpActive: true,
		});

		expect(badges).toContain("ent:on");
		expect(badges).toContain("ent:policy");
		expect(badges).toContain("ent:mcp");
	});

	it("keeps enterprise badge derivation hidden without enterprise sources", () => {
		expect(
			buildEnterpriseRuntimeBadges({
				enterpriseMode: false,
				policyPresent: false,
				enterpriseMcpPresent: false,
			}),
		).toEqual([]);
	});

	it("detects legacy composer enterprise config paths in the TS TUI", () => {
		const tempHome = mkdtempSync(join(tmpdir(), "maestro-badges-"));
		const previousHome = process.env.HOME;
		const previousMaestroHome = process.env.MAESTRO_HOME;
		try {
			process.env.HOME = tempHome;
			delete process.env.MAESTRO_HOME;
			mkdirSync(join(tempHome, ".composer", "enterprise"), {
				recursive: true,
			});
			writeFileSync(join(tempHome, ".composer", "policy.json"), "{}");
			writeFileSync(
				join(tempHome, ".composer", "enterprise", "mcp.json"),
				"{}",
			);

			const badges = buildRuntimeBadges(createBadgeParams());

			expect(badges).toContain("ent:on");
			expect(badges).toContain("ent:policy");
			expect(badges).toContain("ent:mcp");
		} finally {
			if (previousHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = previousHome;
			}
			if (previousMaestroHome === undefined) {
				delete process.env.MAESTRO_HOME;
			} else {
				process.env.MAESTRO_HOME = previousMaestroHome;
			}
			rmSync(tempHome, { recursive: true, force: true });
		}
	});

	it("does not treat enterprise config directories as active config files", () => {
		const tempHome = mkdtempSync(join(tmpdir(), "maestro-badges-"));
		const previousHome = process.env.HOME;
		const previousMaestroHome = process.env.MAESTRO_HOME;
		const previousPolicyPath = process.env.MAESTRO_POLICY_PATH;
		const previousEnterpriseMcpPath = process.env.MAESTRO_ENTERPRISE_MCP_PATH;
		try {
			process.env.HOME = tempHome;
			delete process.env.MAESTRO_HOME;
			process.env.MAESTRO_POLICY_PATH = join(tempHome, ".maestro");
			process.env.MAESTRO_ENTERPRISE_MCP_PATH = join(
				tempHome,
				".maestro",
				"enterprise",
			);
			mkdirSync(process.env.MAESTRO_POLICY_PATH, { recursive: true });
			mkdirSync(process.env.MAESTRO_ENTERPRISE_MCP_PATH, {
				recursive: true,
			});

			const badges = buildRuntimeBadges(createBadgeParams());

			expect(badges).not.toContain("ent:policy");
			expect(badges).not.toContain("ent:mcp");
		} finally {
			if (previousHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = previousHome;
			}
			if (previousMaestroHome === undefined) {
				delete process.env.MAESTRO_HOME;
			} else {
				process.env.MAESTRO_HOME = previousMaestroHome;
			}
			if (previousPolicyPath === undefined) {
				delete process.env.MAESTRO_POLICY_PATH;
			} else {
				process.env.MAESTRO_POLICY_PATH = previousPolicyPath;
			}
			if (previousEnterpriseMcpPath === undefined) {
				delete process.env.MAESTRO_ENTERPRISE_MCP_PATH;
			} else {
				process.env.MAESTRO_ENTERPRISE_MCP_PATH = previousEnterpriseMcpPath;
			}
			rmSync(tempHome, { recursive: true, force: true });
		}
	});

	it("detects symlinked enterprise config files in the TS TUI", () => {
		const tempHome = mkdtempSync(join(tmpdir(), "maestro-badges-"));
		const previousHome = process.env.HOME;
		const previousMaestroHome = process.env.MAESTRO_HOME;
		try {
			process.env.HOME = tempHome;
			delete process.env.MAESTRO_HOME;
			mkdirSync(join(tempHome, "managed"), { recursive: true });
			mkdirSync(join(tempHome, ".maestro", "enterprise"), {
				recursive: true,
			});
			writeFileSync(join(tempHome, "managed", "policy.json"), "{}");
			writeFileSync(join(tempHome, "managed", "mcp.json"), "{}");
			symlinkSync(
				join(tempHome, "managed", "policy.json"),
				join(tempHome, ".maestro", "policy.json"),
			);
			symlinkSync(
				join(tempHome, "managed", "mcp.json"),
				join(tempHome, ".maestro", "enterprise", "mcp.json"),
			);

			const badges = buildRuntimeBadges(createBadgeParams());

			expect(badges).toContain("ent:on");
			expect(badges).toContain("ent:policy");
			expect(badges).toContain("ent:mcp");
		} finally {
			if (previousHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = previousHome;
			}
			if (previousMaestroHome === undefined) {
				delete process.env.MAESTRO_HOME;
			} else {
				process.env.MAESTRO_HOME = previousMaestroHome;
			}
			rmSync(tempHome, { recursive: true, force: true });
		}
	});
});
