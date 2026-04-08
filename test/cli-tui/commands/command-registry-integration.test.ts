import type { SlashCommand } from "@evalops/tui";
import { describe, expect, it, vi } from "vitest";
import type { CommandExecutionContext } from "../../../src/cli-tui/commands/types.js";
import { buildCommandRegistry } from "../../../src/cli-tui/utils/commands/command-registry-builder.js";
import type { CommandRegistryOptions } from "../../../src/cli-tui/utils/commands/command-registry-builder.js";

function createMockContext(
	rawInput: string,
	argumentText = "",
): CommandExecutionContext {
	return {
		command: { name: "test", description: "test" },
		rawInput,
		argumentText,
		showInfo: vi.fn(),
		showError: vi.fn(),
		renderHelp: vi.fn(),
	};
}

function createMockOptions(): CommandRegistryOptions {
	const noop = vi.fn();
	return {
		getRunScriptCompletions: vi.fn(() => null),
		createContext: vi.fn(
			(input: {
				command: SlashCommand;
				rawInput: string;
				argumentText: string;
				parsedArgs?: Record<string, unknown>;
			}) => createMockContext(input.rawInput, input.argumentText),
		),
		showThinkingSelector: noop,
		showModelSelector: noop,
		showThemeSelector: noop,
		handleExportSession: noop,
		handleShareSession: noop,
		handleTools: noop,
		handleToolHistory: noop,
		handleSkills: noop,
		handleImportConfig: noop,
		handleSession: noop,
		handleSessions: noop,
		handleAbout: noop,
		handleHistory: noop,
		handleClear: noop,
		showStatus: noop,
		handleReview: noop,
		handleUndo: noop,
		handleReport: noop,
		handleMention: noop,
		handleAccess: noop,
		handlePii: noop,
		handleAudit: noop,
		handleLimits: noop,
		showHelp: noop,
		handleUpdate: noop,
		handleChangelog: noop,
		handleHotkeys: noop,
		handleConfig: noop,
		handleCost: noop,
		handleQuota: noop,
		handleTelemetry: noop,
		handleOtel: noop,
		handleTraining: noop,
		handleStats: noop,
		handlePlan: noop,
		handlePreview: noop,
		handleRun: noop,
		handleOllama: noop,
		handleDiagnostics: noop,
		handleBackground: noop,
		handleCompact: noop,
		handleAutocompact: noop,
		handleFooter: noop,
		handleCompactTools: noop,
		handleSteer: noop,
		handleQueue: noop,
		handleBranch: noop,
		handleTree: noop,
		handleCommands: noop,
		handleQuit: noop,
		handleApprovals: noop,
		handlePlanMode: noop,
		handleNewChat: noop,
		handleInitAgents: noop,
		handleMcp: noop,
		handleComposer: noop,
		handleLogin: noop,
		handleLogout: noop,
		handleZen: noop,
		handleContext: noop,
		handleLsp: noop,
		handleFramework: noop,
		handleClean: noop,
		handleGuardian: noop,
		handleWorkflow: noop,
		handleChanges: noop,
		handleCheckpoint: noop,
		handleMemory: noop,
		handleMode: noop,
		handlePrompts: noop,
		handleCopy: noop,
		// Grouped command handlers
		handleSessionCommand: noop,
		handleDiagCommand: noop,
		handleUiCommand: noop,
		handleSafetyCommand: noop,
		handleGitCommand: noop,
		handleAuthCommand: noop,
		handleUsageCommand: noop,
		handleUndoCommand: noop,
		handleConfigCommand: noop,
		handleToolsCommand: noop,
	};
}

describe("command-registry-integration", () => {
	it("builds a registry with all expected entries", () => {
		const opts = createMockOptions();
		const { entries, commands } = buildCommandRegistry(opts);

		expect(entries.length).toBeGreaterThan(0);
		expect(commands.length).toBe(entries.length);
	});

	it("uses maestro descriptions for guardian, about, and config", () => {
		const opts = createMockOptions();
		const { commands } = buildCommandRegistry(opts);
		const guardian = commands.find((command) => command.name === "guardian");
		const about = commands.find((command) => command.name === "about");
		const config = commands.find((command) => command.name === "config");

		expect(guardian?.description).toBe(
			"Run Maestro Guardian (Semgrep + secrets) or toggle enforcement",
		);
		expect(about?.description).toBe("Show Maestro build, env, and git info");
		expect(config?.description).toBe(
			"Validate and inspect Maestro configuration",
		);
	});

	it("every entry has a valid command with name and description", () => {
		const opts = createMockOptions();
		const { entries } = buildCommandRegistry(opts);

		for (const entry of entries) {
			expect(entry.command.name).toBeTruthy();
			expect(entry.command.description).toBeTruthy();
			expect(typeof entry.matches).toBe("function");
			expect(typeof entry.execute).toBe("function");
		}
	});

	describe("critical commands are registered", () => {
		const opts = createMockOptions();
		const { commands } = buildCommandRegistry(opts);
		const commandNames = commands.map((c) => c.name);

		const criticalCommands = [
			"help",
			"model",
			"thinking",
			"theme",
			"session",
			"sessions",
			"history",
			"export",
			"share",
			"clear",
			"new",
			"status",
			"about",
			"report",
			"mcp",
			"lsp",
			"tools",
			"toolhistory",
			"skills",
			"run",
			"config",
			"diag",
			"cost",
			"quota",
			"stats",
			"undo",
			"review",
			"compact",
			"autocompact",
			"plan",
			"branch",
			"tree",
			"queue",
			"steer",
			"approvals",
			"plan-mode",
			"guardian",
			"background",
			"login",
			"logout",
			"quit",
			"copy",
			"memory",
			"workflow",
			"framework",
			"init",
			"diff",
			"mention",
			"hotkeys",
			"zen",
			"context",
			"footer",
			"mode",
			"prompts",
			"composer",
			"commands",
			"clean",
			"changes",
			"checkpoint",
			"import",
			"update",
			"changelog",
			"telemetry",
			"otel",
			"training",
			"compact-tools",
			"alerts",
			// Grouped
			"ss",
			"ui",
			"safe",
			"git",
			"auth",
			"usage",
			"cfg",
		];

		for (const name of criticalCommands) {
			it(`has /${name}`, () => {
				expect(commandNames).toContain(name);
			});
		}
	});

	describe("command matching", () => {
		const opts = createMockOptions();
		const { entries } = buildCommandRegistry(opts);

		function findMatchingEntry(input: string) {
			return entries.find((e) => e.matches(input));
		}

		it("matches exact command names", () => {
			const helpEntry = findMatchingEntry("/help");
			expect(helpEntry).toBeDefined();
			expect(helpEntry!.command.name).toBe("help");
		});

		it("matches commands with arguments", () => {
			const thinkingEntry = findMatchingEntry("/thinking medium");
			expect(thinkingEntry).toBeDefined();
			expect(thinkingEntry!.command.name).toBe("thinking");
		});

		it("matches /hotkeys subcommands with arguments", () => {
			const hotkeysEntry = findMatchingEntry("/hotkeys validate");
			expect(hotkeysEntry).toBeDefined();
			expect(hotkeysEntry!.command.name).toBe("hotkeys");
		});

		it("matches /mcp subcommands with arguments", () => {
			const mcpEntry = findMatchingEntry(
				"/mcp add linear https://mcp.linear.app/mcp",
			);
			expect(mcpEntry).toBeDefined();
			expect(mcpEntry!.command.name).toBe("mcp");
		});

		it("matches alias commands", () => {
			const helpAlias = findMatchingEntry("/h");
			expect(helpAlias).toBeDefined();
			expect(helpAlias!.command.name).toBe("help");

			const exportAlias = findMatchingEntry("/e");
			expect(exportAlias).toBeDefined();
			expect(exportAlias!.command.name).toBe("export");
		});

		it("matches /quit aliases", () => {
			expect(findMatchingEntry("/quit")?.command.name).toBe("quit");
			expect(findMatchingEntry("/exit")?.command.name).toBe("quit");
			expect(findMatchingEntry("/q")?.command.name).toBe("quit");
		});

		it("matches /diag and aliases", () => {
			expect(findMatchingEntry("/diag")?.command.name).toBe("diag");
			expect(findMatchingEntry("/diagnostics")?.command.name).toBe("diag");
			expect(findMatchingEntry("/d")?.command.name).toBe("diag");
			expect(findMatchingEntry("/d ")?.command.name).toBe("diag");
		});

		it("does not match unregistered commands", () => {
			expect(findMatchingEntry("/nonexistent")).toBeUndefined();
		});

		it("does not match partial names without the right prefix", () => {
			// "/hel" should not match "/help" (equals matcher)
			expect(findMatchingEntry("/hel")).toBeUndefined();
		});
	});

	describe("command execution dispatches to handlers", () => {
		it("dispatches /help to showHelp handler", () => {
			const opts = createMockOptions();
			const { entries } = buildCommandRegistry(opts);
			const helpEntry = entries.find((e) => e.matches("/help"));

			helpEntry!.execute("/help");

			expect(opts.showHelp).toHaveBeenCalled();
		});

		it("dispatches /model to showModelSelector handler", () => {
			const opts = createMockOptions();
			const { entries } = buildCommandRegistry(opts);
			const modelEntry = entries.find((e) => e.matches("/model"));

			modelEntry!.execute("/model");

			expect(opts.showModelSelector).toHaveBeenCalled();
		});

		it("dispatches /quit to handleQuit handler", () => {
			const opts = createMockOptions();
			const { entries } = buildCommandRegistry(opts);
			const quitEntry = entries.find((e) => e.matches("/quit"));

			quitEntry!.execute("/quit");

			expect(opts.handleQuit).toHaveBeenCalled();
		});

		it("dispatches /ss to handleSessionCommand handler", () => {
			const opts = createMockOptions();
			const { entries } = buildCommandRegistry(opts);
			const ssEntry = entries.find((e) => e.matches("/ss"));

			ssEntry!.execute("/ss");

			expect(opts.handleSessionCommand).toHaveBeenCalled();
		});

		it("dispatches /tools to handleToolsCommand handler", () => {
			const opts = createMockOptions();
			const { entries } = buildCommandRegistry(opts);
			const toolsEntry = entries.find(
				(e) => e.matches("/tools") && e.command.name === "tools",
			);

			toolsEntry!.execute("/tools");

			expect(opts.handleToolsCommand).toHaveBeenCalled();
		});

		it("passes --help flag through to renderHelp", () => {
			const opts = createMockOptions();
			const mockCtx = createMockContext("/thinking --help", "--help");
			vi.mocked(opts.createContext).mockReturnValueOnce(mockCtx);

			const { entries } = buildCommandRegistry(opts);
			const thinkingEntry = entries.find((e) => e.matches("/thinking --help"));

			thinkingEntry!.execute("/thinking --help");

			expect(mockCtx.renderHelp).toHaveBeenCalled();
		});
	});

	it("commands array contains SlashCommand objects matching entries", () => {
		const opts = createMockOptions();
		const { entries, commands } = buildCommandRegistry(opts);

		for (let i = 0; i < entries.length; i++) {
			expect(commands[i]).toBe(entries[i]!.command);
		}
	});

	it("describes /update using Maestro branding", () => {
		const opts = createMockOptions();
		const { commands } = buildCommandRegistry(opts);
		const updateCommand = commands.find((command) => command.name === "update");

		expect(updateCommand?.description).toBe("Check for Maestro CLI updates");
	});

	it("no duplicate command names in the registry", () => {
		const opts = createMockOptions();
		const { commands } = buildCommandRegistry(opts);
		const names = commands.map((c) => c.name);
		// The registry intentionally has "diag" and "undo" as both standalone and grouped
		// so we check that the duplication is known and limited
		const nameCounts = new Map<string, number>();
		for (const name of names) {
			nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
		}
		for (const [name, count] of nameCounts) {
			if (name === "diag" || name === "undo") {
				// These have both standalone and grouped entries
				expect(count).toBeLessThanOrEqual(2);
			} else {
				expect(count).toBe(1);
			}
		}
	});
});
