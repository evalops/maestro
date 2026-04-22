import type { SlashCommand } from "@evalops/tui";
import { describe, expect, it, vi } from "vitest";
import {
	type CommandSuiteHandlers,
	CommandSuiteKey,
} from "../../../src/cli-tui/commands/command-suite-handlers.js";
import type {
	CommandExecutionContext,
	CommandHandlers,
} from "../../../src/cli-tui/commands/types.js";
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

function createMockOptions(): CommandRegistryOptions & {
	commandSuiteHandlers: CommandSuiteHandlers;
} {
	const noop = vi.fn();
	const handlers: CommandHandlers = {
		thinking: noop,
		model: noop,
		exportSession: noop,
		shareSession: noop,
		tools: noop,
		toolHistory: noop,
		skills: noop,
		importConfig: noop,
		session: noop,
		sessions: noop,
		report: noop,
		about: noop,
		history: noop,
		clear: noop,
		status: noop,
		review: noop,
		undoChanges: noop,
		mention: noop,
		access: noop,
		pii: noop,
		audit: noop,
		limits: noop,
		help: noop,
		update: noop,
		changelog: noop,
		hotkeys: noop,
		config: noop,
		cost: noop,
		quota: noop,
		telemetry: noop,
		otel: noop,
		training: noop,
		stats: noop,
		plan: noop,
		preview: noop,
		run: noop,
		ollama: noop,
		diagnostics: noop,
		background: noop,
		compact: noop,
		autocompact: noop,
		footer: noop,
		compactTools: noop,
		steer: noop,
		queue: noop,
		branch: noop,
		tree: noop,
		quit: noop,
		approvals: noop,
		planMode: noop,
		commands: noop,
		newChat: noop,
		initAgents: noop,
		mcp: noop,
		composer: noop,
		login: noop,
		logout: noop,
		zen: noop,
		context: noop,
		lsp: noop,
		theme: noop,
		framework: noop,
		clean: noop,
		guardian: noop,
		workflow: noop,
		changes: noop,
		checkpoint: noop,
		memory: noop,
		mode: noop,
		prompts: noop,
		copy: noop,
		package: noop,
	};
	const commandSuiteHandlers: CommandSuiteHandlers = {
		[CommandSuiteKey.Session]: vi.fn(),
		[CommandSuiteKey.Diag]: vi.fn(),
		[CommandSuiteKey.Ui]: vi.fn(),
		[CommandSuiteKey.Safety]: vi.fn(),
		[CommandSuiteKey.Git]: vi.fn(),
		[CommandSuiteKey.Auth]: vi.fn(),
		[CommandSuiteKey.Usage]: vi.fn(),
		[CommandSuiteKey.Undo]: vi.fn(),
		[CommandSuiteKey.Config]: vi.fn(),
		[CommandSuiteKey.Tools]: vi.fn(),
	};
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
		handlers,
		getCommandSuiteHandlers: vi.fn(() => commandSuiteHandlers),
		commandSuiteHandlers,
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
			"package",
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
			// Command suites
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

		it("matches /package and /plugin aliases", () => {
			expect(findMatchingEntry("/package list")?.command.name).toBe("package");
			expect(findMatchingEntry("/package add ./pack")?.command.name).toBe(
				"package",
			);
			expect(findMatchingEntry("/package validate ./pack")?.command.name).toBe(
				"package",
			);
			expect(findMatchingEntry("/plugin ./pack")?.command.name).toBe("package");
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

			expect(opts.handlers.help).toHaveBeenCalled();
		});

		it("dispatches /model to showModelSelector handler", () => {
			const opts = createMockOptions();
			const { entries } = buildCommandRegistry(opts);
			const modelEntry = entries.find((e) => e.matches("/model"));

			modelEntry!.execute("/model");

			expect(opts.handlers.model).toHaveBeenCalled();
		});

		it("dispatches /quit to handleQuit handler", () => {
			const opts = createMockOptions();
			const { entries } = buildCommandRegistry(opts);
			const quitEntry = entries.find((e) => e.matches("/quit"));

			quitEntry!.execute("/quit");

			expect(opts.handlers.quit).toHaveBeenCalled();
		});

		it("keeps command suite handlers lazy until a suite command executes", () => {
			const opts = createMockOptions();
			const { entries } = buildCommandRegistry(opts);
			const safeEntry = entries.find((e) => e.matches("/safe"));

			expect(opts.getCommandSuiteHandlers).not.toHaveBeenCalled();
			safeEntry!.execute("/safe");

			expect(opts.getCommandSuiteHandlers).toHaveBeenCalledTimes(1);
			expect(
				opts.commandSuiteHandlers[CommandSuiteKey.Safety],
			).toHaveBeenCalled();
		});

		it("dispatches /cfg to the command suite config handler", () => {
			const opts = createMockOptions();
			const { entries } = buildCommandRegistry(opts);
			const configEntry = entries.find((e) => e.matches("/cfg"));

			configEntry!.execute("/cfg");

			expect(
				opts.commandSuiteHandlers[CommandSuiteKey.Config],
			).toHaveBeenCalled();
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
		// The registry intentionally has "diag" and "undo" as both standalone and suite commands
		// so we check that the duplication is known and limited
		const nameCounts = new Map<string, number>();
		for (const name of names) {
			nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
		}
		for (const [name, count] of nameCounts) {
			if (name === "diag" || name === "undo") {
				// These have both standalone and command suite entries
				expect(count).toBeLessThanOrEqual(2);
			} else {
				expect(count).toBe(1);
			}
		}
	});
});
