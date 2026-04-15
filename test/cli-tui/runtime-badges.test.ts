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

import { buildRuntimeBadges } from "../../src/cli-tui/utils/runtime-badges.js";
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
});
