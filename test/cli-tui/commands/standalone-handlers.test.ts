import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Background handlers ─────────────────────────────────────────────────

vi.mock("../../../src/runtime/background-settings.js", () => ({
	getBackgroundSettingsPath: vi.fn(
		() => "/home/user/.maestro/agent/background.json",
	),
	updateBackgroundTaskSettings: vi.fn(),
}));

vi.mock("../../../src/tools/background-tasks.js", () => ({
	backgroundTaskManager: {
		getHealthSnapshot: vi.fn(() => ({
			running: 1,
			total: 3,
			failed: 0,
			detailsRedacted: false,
			history: [],
			historyTruncated: false,
		})),
	},
}));

import {
	type BackgroundRenderContext,
	handleBackgroundCommand,
	parseToggle,
	renderBackgroundHistory,
	renderBackgroundStatus,
} from "../../../src/cli-tui/commands/background-handlers.js";
import type { BackgroundTaskSettings } from "../../../src/runtime/background-settings.js";
import { updateBackgroundTaskSettings } from "../../../src/runtime/background-settings.js";

function createBgCtx(argumentText = ""): BackgroundRenderContext {
	return {
		argumentText,
		addContent: vi.fn(),
		showInfo: vi.fn(),
		showError: vi.fn(),
		renderHelp: vi.fn(),
		requestRender: vi.fn(),
	};
}

const defaultSettings: BackgroundTaskSettings = {
	notificationsEnabled: true,
	statusDetailsEnabled: true,
};

describe("background-handlers", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("parseToggle", () => {
		it("returns true for 'on', 'true', 'enable', 'enabled', 'yes'", () => {
			for (const val of ["on", "true", "enable", "enabled", "yes"]) {
				expect(parseToggle(val)).toBe(true);
			}
		});

		it("returns false for 'off', 'false', 'disable', 'disabled', 'no'", () => {
			for (const val of ["off", "false", "disable", "disabled", "no"]) {
				expect(parseToggle(val)).toBe(false);
			}
		});

		it("returns null for undefined or unrecognized values", () => {
			expect(parseToggle()).toBe(null);
			expect(parseToggle("maybe")).toBe(null);
		});

		it("is case-insensitive", () => {
			expect(parseToggle("ON")).toBe(true);
			expect(parseToggle("Off")).toBe(false);
		});
	});

	describe("handleBackgroundCommand", () => {
		it("defaults to status when no action given", () => {
			const ctx = createBgCtx("");
			handleBackgroundCommand(defaultSettings, ctx);
			expect(ctx.addContent).toHaveBeenCalled();
			expect(ctx.requestRender).toHaveBeenCalled();
		});

		it("routes 'status' to renderBackgroundStatus", () => {
			const ctx = createBgCtx("status");
			handleBackgroundCommand(defaultSettings, ctx);
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("Background tasks"),
			);
		});

		it("handles 'notify on'", () => {
			const ctx = createBgCtx("notify on");
			handleBackgroundCommand(defaultSettings, ctx);
			expect(updateBackgroundTaskSettings).toHaveBeenCalledWith({
				notificationsEnabled: true,
			});
			expect(ctx.showInfo).toHaveBeenCalledWith(
				expect.stringContaining("enabled"),
			);
		});

		it("handles 'notify off'", () => {
			const ctx = createBgCtx("notify off");
			handleBackgroundCommand(defaultSettings, ctx);
			expect(updateBackgroundTaskSettings).toHaveBeenCalledWith({
				notificationsEnabled: false,
			});
		});

		it("shows error when notify has no toggle value", () => {
			const ctx = createBgCtx("notify");
			handleBackgroundCommand(defaultSettings, ctx);
			expect(ctx.showError).toHaveBeenCalledWith("Provide 'on' or 'off'.");
		});

		it("handles 'details on'", () => {
			const ctx = createBgCtx("details on");
			handleBackgroundCommand(defaultSettings, ctx);
			expect(updateBackgroundTaskSettings).toHaveBeenCalledWith({
				statusDetailsEnabled: true,
			});
		});

		it("handles 'history' subcommand", () => {
			const ctx = createBgCtx("history");
			handleBackgroundCommand(
				{ ...defaultSettings, statusDetailsEnabled: true },
				ctx,
			);
			// history with no entries shows a fallback message
			expect(ctx.addContent).toHaveBeenCalled();
		});

		it("handles 'path' subcommand", () => {
			const ctx = createBgCtx("path");
			handleBackgroundCommand(defaultSettings, ctx);
			expect(ctx.showInfo).toHaveBeenCalledWith(
				expect.stringContaining("Background settings file"),
			);
		});

		it("falls back to renderHelp for unknown action", () => {
			const ctx = createBgCtx("unknown");
			handleBackgroundCommand(defaultSettings, ctx);
			expect(ctx.renderHelp).toHaveBeenCalled();
		});
	});

	describe("renderBackgroundStatus", () => {
		it("renders status with snapshot data", () => {
			const ctx = createBgCtx();
			renderBackgroundStatus(defaultSettings, ctx);
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("Background tasks"),
			);
		});
	});

	describe("renderBackgroundHistory", () => {
		it("shows info when details are disabled", () => {
			const ctx = createBgCtx();
			renderBackgroundHistory(
				10,
				{ ...defaultSettings, statusDetailsEnabled: false },
				ctx,
			);
			expect(ctx.showInfo).toHaveBeenCalledWith(
				expect.stringContaining("Enable /background details"),
			);
		});

		it("shows 'no history' when history is empty", () => {
			const ctx = createBgCtx();
			renderBackgroundHistory(10, defaultSettings, ctx);
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("No background task history"),
			);
		});
	});
});

// ── Memory handlers ─────────────────────────────────────────────────────

vi.mock("../../../src/memory/index.js", () => ({
	addMemory: vi.fn(() => ({
		id: "mem_123",
		topic: "test",
		content: "test content",
		updatedAt: Date.now(),
	})),
	searchMemories: vi.fn(() => []),
	getTopicMemories: vi.fn(() => []),
	listTopics: vi.fn(() => []),
	deleteMemory: vi.fn(() => true),
	deleteTopicMemories: vi.fn(() => 2),
	getStats: vi.fn(() => ({
		totalEntries: 5,
		topics: 2,
		oldestEntry: Date.now() - 86400000,
		newestEntry: Date.now(),
	})),
	exportMemories: vi.fn(() => ({ entries: [] })),
	importMemories: vi.fn(() => ({ added: 1, updated: 0, skipped: 0 })),
	clearAllMemories: vi.fn(() => 5),
	getRecentMemories: vi.fn(() => []),
}));

import {
	type MemoryRenderContext,
	handleMemoryCommand,
} from "../../../src/cli-tui/commands/memory-handlers.js";
import { addMemory, searchMemories } from "../../../src/memory/index.js";

function createMemoryCtx(rawInput: string): MemoryRenderContext {
	return {
		rawInput,
		cwd: "/tmp",
		sessionId: "test-session",
		addContent: vi.fn(),
		showError: vi.fn(),
		showInfo: vi.fn(),
		showSuccess: vi.fn(),
		requestRender: vi.fn(),
	};
}

describe("memory-handlers", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("handleMemoryCommand", () => {
		it("shows help when no subcommand given", () => {
			const ctx = createMemoryCtx("/memory");
			handleMemoryCommand(ctx);
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("Memory Commands"),
			);
		});

		it("saves a memory with topic and content", () => {
			const ctx = createMemoryCtx(
				"/memory save api-design Use REST conventions #rest",
			);
			handleMemoryCommand(ctx);
			expect(addMemory).toHaveBeenCalledWith(
				"api-design",
				expect.stringContaining("REST conventions"),
				expect.objectContaining({ tags: ["rest"] }),
			);
			expect(ctx.showSuccess).toHaveBeenCalled();
		});

		it("shows error when save has no content", () => {
			const ctx = createMemoryCtx("/memory save");
			handleMemoryCommand(ctx);
			expect(ctx.showError).toHaveBeenCalledWith(
				expect.stringContaining("Usage"),
			);
		});

		it("searches memories", () => {
			const ctx = createMemoryCtx("/memory search REST");
			handleMemoryCommand(ctx);
			expect(searchMemories).toHaveBeenCalledWith("REST", { limit: 10 });
		});

		it("shows error when search has no query", () => {
			const ctx = createMemoryCtx("/memory search");
			handleMemoryCommand(ctx);
			expect(ctx.showError).toHaveBeenCalledWith(
				expect.stringContaining("Usage"),
			);
		});

		it("lists all topics", () => {
			const ctx = createMemoryCtx("/memory list");
			handleMemoryCommand(ctx);
			// With empty topics, shows info
			expect(ctx.showInfo).toHaveBeenCalledWith(
				expect.stringContaining("No memories saved"),
			);
		});

		it("shows stats", () => {
			const ctx = createMemoryCtx("/memory stats");
			handleMemoryCommand(ctx);
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("Memory Statistics"),
			);
		});

		it("shows recent memories", () => {
			const ctx = createMemoryCtx("/memory recent");
			handleMemoryCommand(ctx);
			// With no recent memories, shows info
			expect(ctx.showInfo).toHaveBeenCalledWith(
				expect.stringContaining("No memories saved"),
			);
		});

		it("exports to a maestro filename by default", () => {
			const ctx = createMemoryCtx("/memory export");
			handleMemoryCommand(ctx);
			expect(ctx.showSuccess).toHaveBeenCalledWith(
				expect.stringContaining("maestro-memories.json"),
			);
			expect(ctx.showSuccess).not.toHaveBeenCalledWith(
				expect.stringContaining("composer-memories.json"),
			);
		});

		it("handles delete with id", () => {
			const ctx = createMemoryCtx("/memory delete mem_123");
			handleMemoryCommand(ctx);
			expect(ctx.showSuccess).toHaveBeenCalled();
		});

		it("shows error when delete has no target", () => {
			const ctx = createMemoryCtx("/memory delete");
			handleMemoryCommand(ctx);
			expect(ctx.showError).toHaveBeenCalledWith(
				expect.stringContaining("Usage"),
			);
		});

		it("handles clear without force", () => {
			const ctx = createMemoryCtx("/memory clear");
			handleMemoryCommand(ctx);
			expect(ctx.showInfo).toHaveBeenCalledWith(
				expect.stringContaining("--force"),
			);
		});
	});
});

// ── MCP handlers ────────────────────────────────────────────────────────

const mockOfficialRegistryEntry = {
	displayName: "Linear",
	slug: "linear",
	serverName: "linear/linear",
	transport: "http" as const,
	url: "https://mcp.linear.app/mcp",
	documentationUrl: "https://linear.app/docs/mcp",
	oneLiner: "Issue and project management",
};

function createDefaultMcpStatus() {
	return {
		authPresets: [
			{
				name: "linear-auth",
				scope: "local" as const,
				headerKeys: ["Authorization"],
				headersHelper: "op run --env-file",
			},
		],
		servers: [
			{
				name: "test-server",
				connected: true,
				scope: "project" as const,
				transport: "stdio" as const,
				tools: [{ name: "test_tool" }],
				resources: ["resource://test"],
				prompts: ["my-prompt"],
				promptDetails: [
					{
						name: "my-prompt",
						title: "Summarize issue",
						description: "Summarize a tracked issue",
						arguments: [
							{
								name: "ISSUE",
								description: "Issue identifier",
								required: true,
							},
						],
					},
				],
			},
			{
				name: "broken-server",
				connected: false,
				scope: "user" as const,
				transport: "http" as const,
				tools: [],
				resources: [],
				prompts: [],
				remoteUrl: "https://mcp.linear.app/mcp",
				remoteTrust: "official" as const,
				officialRegistry: {
					displayName: "Linear",
					documentationUrl: "https://linear.app/docs/mcp",
					permissions: "Read and write",
				},
				error: "Connection refused",
				authPreset: "linear-auth",
				headerKeys: ["Authorization"],
				headersHelper: "op run --env-file",
			},
		],
	};
}

vi.mock("../../../src/mcp/index.js", () => ({
	addMcpAuthPresetToConfig: vi.fn(() => ({
		path: "/tmp/project/.maestro/mcp.local.json",
	})),
	addMcpServerToConfig: vi.fn(() => ({
		path: "/tmp/project/.maestro/mcp.local.json",
	})),
	buildSuggestedMcpServerName: vi.fn(() => "linear"),
	getOfficialMcpRegistryEntries: vi.fn(() => [mockOfficialRegistryEntry]),
	getOfficialMcpRegistryUrls: vi.fn((entry: { url?: string }) =>
		entry.url ? [entry.url] : [],
	),
	getOfficialMcpRegistryMatch: vi.fn(() => ({
		trust: "official",
		info: {
			displayName: "Linear",
			documentationUrl: "https://linear.app/docs/mcp",
		},
	})),
	inferRemoteMcpTransport: vi.fn(() => "http"),
	loadMcpConfig: vi.fn(() => ({
		servers: [],
		authPresets: [
			{
				name: "linear-auth",
				headers: { Authorization: "Bearer test" },
				headersHelper: "op run --env-file",
				scope: "local",
			},
		],
	})),
	mcpManager: {
		getStatus: vi.fn(() => createDefaultMcpStatus()),
		configure: vi.fn().mockResolvedValue(undefined),
		readResource: vi.fn(),
		getPrompt: vi.fn(),
	},
	normalizeMcpRemoteUrl: vi.fn((url: string) => url),
	officialMcpRegistryEntryMatchesUrl: vi.fn(() => true),
	prefetchOfficialMcpRegistry: vi.fn().mockResolvedValue(undefined),
	removeMcpAuthPresetFromConfig: vi.fn(() => ({
		path: "/tmp/project/.maestro/mcp.local.json",
		scope: "local",
	})),
	removeMcpServerFromConfig: vi.fn(() => ({
		path: "/tmp/project/.maestro/mcp.local.json",
		scope: "local",
	})),
	resolveOfficialMcpRegistryEntry: vi.fn((query: string) => ({
		entry:
			query === "linear" || query === "Linear"
				? mockOfficialRegistryEntry
				: undefined,
		matches:
			query === "linear" || query === "Linear"
				? [mockOfficialRegistryEntry]
				: [],
	})),
	searchOfficialMcpRegistry: vi.fn(() => [mockOfficialRegistryEntry]),
	updateMcpAuthPresetInConfig: vi.fn(() => ({
		path: "/tmp/project/.maestro/mcp.local.json",
		scope: "local",
	})),
	updateMcpServerInConfig: vi.fn(() => ({
		path: "/tmp/project/.maestro/mcp.local.json",
		scope: "local",
	})),
}));

import {
	type McpRenderContext,
	formatMcpPromptList,
	handleMcpCommand,
	handleMcpPromptsCommand,
	handleMcpResourcesCommand,
} from "../../../src/cli-tui/commands/mcp-handlers.js";
import {
	addMcpAuthPresetToConfig,
	addMcpServerToConfig,
	buildSuggestedMcpServerName,
	getOfficialMcpRegistryEntries,
	loadMcpConfig,
	mcpManager,
	prefetchOfficialMcpRegistry,
	removeMcpAuthPresetFromConfig,
	removeMcpServerFromConfig,
	resolveOfficialMcpRegistryEntry,
	searchOfficialMcpRegistry,
	updateMcpAuthPresetInConfig,
	updateMcpServerInConfig,
} from "../../../src/mcp/index.js";

function createMcpCtx(rawInput: string): McpRenderContext {
	return {
		rawInput,
		addContent: vi.fn(),
		showError: vi.fn(),
		requestRender: vi.fn(),
	};
}

describe("mcp-handlers", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(mcpManager.getStatus).mockImplementation(() =>
			createDefaultMcpStatus(),
		);
	});

	describe("handleMcpCommand", () => {
		it("shows server status by default", () => {
			const ctx = createMcpCtx("/mcp");
			handleMcpCommand(ctx);
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("Model Context Protocol"),
			);
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("Auth presets"),
			);
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("linear-auth"),
			);
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("test-server"),
			);
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("Source: Project config"),
			);
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("Transport: stdio"),
			);
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("broken-server"),
			);
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("Transport: HTTP"),
			);
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("Remote: https://mcp.linear.app/mcp"),
			);
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("Auth preset: linear-auth"),
			);
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("Headers helper: op run --env-file"),
			);
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("Trust: Official registry (Linear)"),
			);
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("Docs: https://linear.app/docs/mcp"),
			);
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("Permissions: Read and write"),
			);
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("Error: Connection refused"),
			);
		});

		it("falls back to a generic message for blank server errors", () => {
			vi.mocked(mcpManager.getStatus).mockReturnValueOnce({
				authPresets: [],
				servers: [
					{
						name: "blank-error",
						connected: false,
						scope: "user",
						transport: "http",
						tools: [],
						resources: [],
						prompts: [],
						error: "   ",
					},
				],
			});

			const ctx = createMcpCtx("/mcp");
			handleMcpCommand(ctx);

			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("Error: Connection failed."),
			);
		});

		it("routes 'resources' subcommand", () => {
			const ctx = createMcpCtx("/mcp resources");
			handleMcpCommand(ctx);
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("MCP Resources"),
			);
		});

		it("routes 'prompts' subcommand", () => {
			const ctx = createMcpCtx("/mcp prompts");
			handleMcpCommand(ctx);
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("MCP Prompts"),
			);
		});

		it("filters MCP prompts to a specific server and shows metadata", () => {
			const output = formatMcpPromptList(
				createDefaultMcpStatus().servers,
				"test-server",
			);

			expect(output).toContain("test-server");
			expect(output).toContain("my-prompt");
			expect(output).toContain("Title: Summarize issue");
			expect(output).toContain("Description: Summarize a tracked issue");
			expect(output).toContain("Args: ISSUE (required): Issue identifier");
			expect(output).not.toContain("broken-server");
			expect(output).toContain(
				"Usage: /mcp prompts <server> <name> [KEY=value ...]",
			);
		});

		it("passes KEY=value prompt args through the TUI MCP prompt command", async () => {
			vi.mocked(mcpManager.getPrompt).mockResolvedValueOnce({
				description: "Summarize a tracked issue",
				messages: [{ role: "user", content: "Summarize issue MAE-1" }],
			});
			const ctx = createMcpCtx(
				'/mcp prompts test-server my-prompt ISSUE=MAE-1 mode="full text"',
			);

			handleMcpCommand(ctx);

			await vi.waitFor(() => {
				expect(mcpManager.getPrompt).toHaveBeenCalledWith(
					"test-server",
					"my-prompt",
					{
						ISSUE: "MAE-1",
						mode: "full text",
					},
				);
			});
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("Summarize issue MAE-1"),
			);
		});

		it("shows an error for invalid MCP prompt args in the TUI command", () => {
			const ctx = createMcpCtx(
				"/mcp prompts test-server my-prompt invalid-arg",
			);

			handleMcpCommand(ctx);

			expect(mcpManager.getPrompt).not.toHaveBeenCalled();
			expect(ctx.showError).toHaveBeenCalledWith(
				"Invalid MCP prompt argument. Use KEY=value after the prompt name.",
			);
		});

		it("adds a remote MCP server and reloads the manager", async () => {
			const ctx = createMcpCtx(
				"/mcp add linear https://mcp.linear.app/mcp --scope project",
			);

			handleMcpCommand(ctx);

			await vi.waitFor(() => {
				expect(prefetchOfficialMcpRegistry).toHaveBeenCalledTimes(1);
				expect(addMcpServerToConfig).toHaveBeenCalledWith({
					projectRoot: process.cwd(),
					scope: "project",
					server: {
						name: "linear",
						transport: "http",
						url: "https://mcp.linear.app/mcp",
						headers: undefined,
						headersHelper: undefined,
					},
				});
				expect(loadMcpConfig).toHaveBeenCalledWith(process.cwd(), {
					includeEnvLimits: true,
				});
				expect(mcpManager.configure).toHaveBeenCalledTimes(1);
			});

			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining('Added MCP server "linear"'),
			);
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("trust: official (Linear)"),
			);
		});

		it("adds a remote MCP server with an auth preset", async () => {
			const ctx = createMcpCtx(
				"/mcp add linear https://mcp.linear.app/mcp --auth-preset linear-auth",
			);

			handleMcpCommand(ctx);

			await vi.waitFor(() => {
				expect(addMcpServerToConfig).toHaveBeenCalledWith({
					projectRoot: process.cwd(),
					scope: "local",
					server: {
						name: "linear",
						transport: "http",
						url: "https://mcp.linear.app/mcp",
						headers: undefined,
						headersHelper: undefined,
						authPreset: "linear-auth",
					},
				});
			});

			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("auth preset: linear-auth"),
			);
		});

		it("parses stdio MCP servers after --", async () => {
			const ctx = createMcpCtx(
				"/mcp add filesystem --scope local -- npx -y @modelcontextprotocol/server-filesystem .",
			);

			handleMcpCommand(ctx);

			await vi.waitFor(() => {
				expect(addMcpServerToConfig).toHaveBeenCalledWith({
					projectRoot: process.cwd(),
					scope: "local",
					server: {
						name: "filesystem",
						transport: "stdio",
						command: "npx",
						args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
						env: undefined,
						cwd: undefined,
					},
				});
				expect(ctx.addContent).toHaveBeenCalledWith(
					expect.stringContaining("command: npx"),
				);
			});
		});

		it("edits an existing MCP server and reloads the manager", async () => {
			vi.mocked(loadMcpConfig)
				.mockReturnValueOnce({
					servers: [
						{
							name: "linear",
							transport: "http",
							url: "https://mcp.linear.app/mcp",
							scope: "local",
						},
					],
					authPresets: [
						{
							name: "linear-auth",
							headers: { Authorization: "Bearer test" },
							scope: "local",
						},
					],
				})
				.mockReturnValueOnce({
					servers: [
						{
							name: "linear",
							transport: "http",
							url: "https://mcp.linear.app/mcp/v2",
							scope: "local",
						},
					],
					authPresets: [
						{
							name: "linear-auth",
							headers: { Authorization: "Bearer test" },
							scope: "local",
						},
					],
				});

			const ctx = createMcpCtx(
				"/mcp edit linear https://mcp.linear.app/mcp/v2",
			);
			handleMcpCommand(ctx);

			await vi.waitFor(() => {
				expect(updateMcpServerInConfig).toHaveBeenCalledWith({
					projectRoot: process.cwd(),
					scope: undefined,
					name: "linear",
					server: {
						name: "linear",
						transport: "http",
						url: "https://mcp.linear.app/mcp/v2",
						headers: undefined,
						headersHelper: undefined,
					},
				});
				expect(mcpManager.configure).toHaveBeenCalledTimes(1);
			});

			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining('Updated MCP server "linear"'),
			);
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("remote: https://mcp.linear.app/mcp/v2"),
			);
		});

		it("removes an MCP server and reports lower-precedence fallback config", async () => {
			vi.mocked(loadMcpConfig).mockReturnValueOnce({
				servers: [
					{
						name: "linear",
						transport: "http",
						url: "https://mcp.linear.app/mcp",
						scope: "user",
					},
				],
				authPresets: [],
			});

			const ctx = createMcpCtx("/mcp remove linear");
			handleMcpCommand(ctx);

			await vi.waitFor(() => {
				expect(removeMcpServerFromConfig).toHaveBeenCalledWith({
					projectRoot: process.cwd(),
					scope: undefined,
					name: "linear",
				});
				expect(mcpManager.configure).toHaveBeenCalledTimes(1);
				expect(ctx.addContent).toHaveBeenCalledWith(
					expect.stringContaining('Removed MCP server "linear"'),
				);
			});
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("fallback: now using User config"),
			);
		});

		it("searches the official MCP registry", async () => {
			const ctx = createMcpCtx("/mcp search linear");
			handleMcpCommand(ctx);

			await vi.waitFor(() => {
				expect(prefetchOfficialMcpRegistry).toHaveBeenCalledTimes(1);
				expect(getOfficialMcpRegistryEntries).toHaveBeenCalledTimes(1);
				expect(searchOfficialMcpRegistry).toHaveBeenCalledWith("linear", {
					limit: 8,
				});
				expect(ctx.addContent).toHaveBeenCalledWith(
					expect.stringContaining('Official MCP Registry matches for "linear"'),
				);
			});
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("Linear"),
			);
		});

		it("imports an official MCP server entry", async () => {
			vi.mocked(loadMcpConfig)
				.mockReturnValueOnce({
					servers: [],
					authPresets: [
						{
							name: "linear-auth",
							headers: { Authorization: "Bearer test" },
							scope: "local",
						},
					],
				})
				.mockReturnValueOnce({
					servers: [
						{
							name: "linear",
							transport: "http",
							url: "https://mcp.linear.app/mcp",
							scope: "local",
						},
					],
					authPresets: [
						{
							name: "linear-auth",
							headers: { Authorization: "Bearer test" },
							scope: "local",
						},
					],
				});

			const ctx = createMcpCtx("/mcp import linear");
			handleMcpCommand(ctx);

			await vi.waitFor(() => {
				expect(resolveOfficialMcpRegistryEntry).toHaveBeenCalledWith("linear");
				expect(buildSuggestedMcpServerName).toHaveBeenCalledWith(
					mockOfficialRegistryEntry,
				);
				expect(addMcpServerToConfig).toHaveBeenCalledWith({
					projectRoot: process.cwd(),
					scope: "local",
					server: {
						name: "linear",
						transport: "http",
						url: "https://mcp.linear.app/mcp",
						headers: undefined,
						headersHelper: undefined,
					},
				});
			});

			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining('Imported official MCP server "linear"'),
			);
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("source: Linear"),
			);
		});

		it("shows usage for incomplete add commands", async () => {
			const ctx = createMcpCtx("/mcp add");
			handleMcpCommand(ctx);

			await vi.waitFor(() => {
				expect(ctx.showError).toHaveBeenCalledWith(
					expect.stringContaining("/mcp add <name> <command-or-url>"),
				);
			});
		});

		it("lists MCP auth presets", async () => {
			const ctx = createMcpCtx("/mcp auth");

			handleMcpCommand(ctx);

			await vi.waitFor(() => {
				expect(ctx.addContent).toHaveBeenCalledWith(
					expect.stringContaining("MCP Auth Presets"),
				);
			});
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("linear-auth"),
			);
		});

		it("adds an MCP auth preset and reloads the manager", async () => {
			const ctx = createMcpCtx(
				"/mcp auth add github-auth --scope project --header 'Authorization: Bearer test' --headers-helper 'op run --env-file'",
			);

			handleMcpCommand(ctx);

			await vi.waitFor(() => {
				expect(addMcpAuthPresetToConfig).toHaveBeenCalledWith({
					projectRoot: process.cwd(),
					scope: "project",
					preset: {
						name: "github-auth",
						headers: { Authorization: "Bearer test" },
						headersHelper: "op run --env-file",
					},
				});
				expect(mcpManager.configure).toHaveBeenCalledTimes(1);
				expect(ctx.addContent).toHaveBeenCalledWith(
					expect.stringContaining('Added MCP auth preset "github-auth"'),
				);
			});
		});

		it("edits an MCP auth preset and reloads the manager", async () => {
			vi.mocked(loadMcpConfig)
				.mockReturnValueOnce({
					servers: [],
					authPresets: [
						{
							name: "linear-auth",
							headers: { Authorization: "Bearer test" },
							scope: "local",
						},
					],
				})
				.mockReturnValueOnce({
					servers: [],
					authPresets: [
						{
							name: "linear-auth",
							headers: { Authorization: "Bearer next" },
							scope: "local",
						},
					],
				});

			const ctx = createMcpCtx(
				"/mcp auth edit linear-auth --header 'Authorization: Bearer next'",
			);

			handleMcpCommand(ctx);

			await vi.waitFor(() => {
				expect(updateMcpAuthPresetInConfig).toHaveBeenCalledWith({
					projectRoot: process.cwd(),
					scope: undefined,
					name: "linear-auth",
					preset: {
						name: "linear-auth",
						headers: { Authorization: "Bearer next" },
						headersHelper: undefined,
					},
				});
				expect(mcpManager.configure).toHaveBeenCalledTimes(1);
				expect(ctx.addContent).toHaveBeenCalledWith(
					expect.stringContaining('Updated MCP auth preset "linear-auth"'),
				);
			});
		});

		it("accepts /mcp preset aliases for auth preset edits", async () => {
			vi.mocked(loadMcpConfig)
				.mockReturnValueOnce({
					servers: [],
					authPresets: [
						{
							name: "linear-auth",
							headers: { Authorization: "Bearer test" },
							scope: "local",
						},
					],
				})
				.mockReturnValueOnce({
					servers: [],
					authPresets: [
						{
							name: "linear-auth",
							headers: { Authorization: "Bearer next" },
							scope: "local",
						},
					],
				});

			const ctx = createMcpCtx(
				"/mcp preset edit linear-auth --header 'Authorization: Bearer next'",
			);

			handleMcpCommand(ctx);

			await vi.waitFor(() => {
				expect(updateMcpAuthPresetInConfig).toHaveBeenCalledWith({
					projectRoot: process.cwd(),
					scope: undefined,
					name: "linear-auth",
					preset: {
						name: "linear-auth",
						headers: { Authorization: "Bearer next" },
						headersHelper: undefined,
					},
				});
			});
		});

		it("removes an MCP auth preset and reports fallback config", async () => {
			vi.mocked(loadMcpConfig).mockReturnValueOnce({
				servers: [],
				authPresets: [
					{
						name: "linear-auth",
						headers: { Authorization: "Bearer test" },
						scope: "user",
					},
				],
			});

			const ctx = createMcpCtx("/mcp auth remove linear-auth");

			handleMcpCommand(ctx);

			await vi.waitFor(() => {
				expect(removeMcpAuthPresetFromConfig).toHaveBeenCalledWith({
					projectRoot: process.cwd(),
					scope: undefined,
					name: "linear-auth",
				});
				expect(ctx.addContent).toHaveBeenCalledWith(
					expect.stringContaining('Removed MCP auth preset "linear-auth"'),
				);
			});

			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("fallback: now using User config"),
			);
		});

		it("surfaces /mcp auth parse errors as user-visible command errors", async () => {
			const ctx = createMcpCtx('/mcp auth "unterminated');

			handleMcpCommand(ctx);

			await vi.waitFor(() => {
				expect(ctx.showError).toHaveBeenCalledWith(
					expect.stringContaining("Invalid /mcp command"),
				);
			});
		});
	});

	describe("handleMcpResourcesCommand", () => {
		it("lists resources from connected servers", () => {
			const ctx = createMcpCtx("/mcp resources");
			handleMcpResourcesCommand([], ctx);
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("resource://test"),
			);
		});
	});

	describe("handleMcpPromptsCommand", () => {
		it("lists prompts from connected servers", () => {
			const ctx = createMcpCtx("/mcp prompts");
			handleMcpPromptsCommand([], ctx);
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("my-prompt"),
			);
		});
	});
});

// ── Workflow handlers ───────────────────────────────────────────────────

vi.mock("../../../src/workflows/index.js", () => ({
	executeWorkflow: vi.fn(),
	getWorkflow: vi.fn(),
	hasWorkflowsDirectory: vi.fn(() => true),
	listWorkflowNames: vi.fn(() => ["setup", "deploy"]),
	validateWorkflow: vi.fn(() => ({ valid: true, errors: [] })),
}));

import {
	type WorkflowRenderContext,
	handleWorkflowCommand,
} from "../../../src/cli-tui/commands/workflow-handlers.js";
import {
	getWorkflow,
	hasWorkflowsDirectory,
	listWorkflowNames,
	validateWorkflow,
} from "../../../src/workflows/index.js";

function createWorkflowCtx(rawInput: string): WorkflowRenderContext {
	return {
		rawInput,
		cwd: "/tmp",
		tools: new Map(),
		addContent: vi.fn(),
		showError: vi.fn(),
		showInfo: vi.fn(),
		showSuccess: vi.fn(),
		requestRender: vi.fn(),
	};
}

describe("workflow-handlers", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("handleWorkflowCommand", () => {
		it("shows help when no subcommand given", () => {
			const ctx = createWorkflowCtx("/workflow");
			handleWorkflowCommand(ctx);
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("Workflow Commands"),
			);
		});

		it("lists workflows", async () => {
			const ctx = createWorkflowCtx("/workflow list");
			await handleWorkflowCommand(ctx);
			expect(listWorkflowNames).toHaveBeenCalledWith("/tmp");
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("2 workflow(s)"),
			);
		});

		it("shows error when run has no name", async () => {
			const ctx = createWorkflowCtx("/workflow run");
			await handleWorkflowCommand(ctx);
			expect(ctx.showError).toHaveBeenCalledWith(
				expect.stringContaining("Usage"),
			);
		});

		it("shows error when workflow not found", async () => {
			vi.mocked(getWorkflow).mockReturnValueOnce(undefined as never);
			const ctx = createWorkflowCtx("/workflow run nonexistent");
			await handleWorkflowCommand(ctx);
			expect(ctx.showError).toHaveBeenCalledWith(
				expect.stringContaining("not found"),
			);
		});

		it("validates workflow", async () => {
			vi.mocked(getWorkflow).mockReturnValueOnce({
				name: "test",
				steps: [],
			} as never);
			vi.mocked(validateWorkflow).mockReturnValueOnce({
				valid: true,
				errors: [],
			});

			const ctx = createWorkflowCtx("/workflow validate test");
			await handleWorkflowCommand(ctx);
			expect(ctx.showSuccess).toHaveBeenCalledWith(
				expect.stringContaining("valid"),
			);
		});

		it("shows workflow details", async () => {
			vi.mocked(getWorkflow).mockReturnValueOnce({
				name: "test",
				description: "A test workflow",
				steps: [{ id: "step1", tool: "bash", params: { command: "echo hi" } }],
			} as never);

			const ctx = createWorkflowCtx("/workflow show test");
			await handleWorkflowCommand(ctx);
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("step1"),
			);
		});

		it("shows no workflows message when directory is missing", async () => {
			vi.mocked(hasWorkflowsDirectory).mockReturnValueOnce(false);
			const ctx = createWorkflowCtx("/workflow list");
			await handleWorkflowCommand(ctx);
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("No workflows directory"),
			);
		});
	});
});
