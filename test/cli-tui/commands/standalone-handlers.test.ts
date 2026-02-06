import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Background handlers ─────────────────────────────────────────────────

vi.mock("../../../src/runtime/background-settings.js", () => ({
	getBackgroundSettingsPath: vi.fn(
		() => "/home/user/.composer/agent/background.json",
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

vi.mock("../../../src/mcp/index.js", () => ({
	mcpManager: {
		getStatus: vi.fn(() => ({
			servers: [
				{
					name: "test-server",
					connected: true,
					tools: [{ name: "test_tool" }],
					resources: ["resource://test"],
					prompts: ["my-prompt"],
				},
			],
		})),
		readResource: vi.fn(),
		getPrompt: vi.fn(),
	},
}));

import {
	type McpRenderContext,
	handleMcpCommand,
	handleMcpPromptsCommand,
	handleMcpResourcesCommand,
} from "../../../src/cli-tui/commands/mcp-handlers.js";

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
	});

	describe("handleMcpCommand", () => {
		it("shows server status by default", () => {
			const ctx = createMcpCtx("/mcp");
			handleMcpCommand(ctx);
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("Model Context Protocol"),
			);
			expect(ctx.addContent).toHaveBeenCalledWith(
				expect.stringContaining("test-server"),
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
