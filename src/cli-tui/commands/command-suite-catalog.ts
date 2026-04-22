import type { SlashCommand } from "@evalops/tui";
import { CommandSuiteKey } from "./command-suite-handlers.js";
import {
	AUTH_SUBCOMMANDS,
	CONFIG_SUBCOMMANDS,
	DIAG_SUBCOMMANDS,
	GIT_SUBCOMMANDS,
	SAFETY_SUBCOMMANDS,
	SESSION_SUBCOMMANDS,
	type SubcommandDef,
	TOOLS_SUBCOMMANDS,
	UI_SUBCOMMANDS,
	UNDO_SUBCOMMANDS,
	USAGE_SUBCOMMANDS,
} from "./subcommands/index.js";

export type CommandSuiteDefinition = {
	key: CommandSuiteKey;
	command: SlashCommand;
	subcommands: readonly SubcommandDef[];
};

const COMMAND_SUITE_ORDER = [
	CommandSuiteKey.Session,
	CommandSuiteKey.Diag,
	CommandSuiteKey.Ui,
	CommandSuiteKey.Safety,
	CommandSuiteKey.Git,
	CommandSuiteKey.Auth,
	CommandSuiteKey.Usage,
	CommandSuiteKey.Undo,
	CommandSuiteKey.Config,
	CommandSuiteKey.Tools,
] as const;

const COMMAND_SUITE_CATALOG: Record<
	CommandSuiteKey,
	Omit<CommandSuiteDefinition, "key">
> = {
	[CommandSuiteKey.Session]: {
		command: {
			name: "ss",
			description:
				"Session management: new, clear, list, load, branch, tree, export, share",
			usage:
				"/ss [new|clear|list|load <id>|branch <n>|tree|export|share|queue|info]",
			tags: ["session"],
			examples: [
				"/ss",
				"/ss new",
				"/ss list",
				"/ss load 3",
				"/ss branch 2",
				"/ss export",
			],
		},
		subcommands: SESSION_SUBCOMMANDS,
	},
	[CommandSuiteKey.Diag]: {
		command: {
			name: "diag",
			description:
				"Diagnostics: status, about, context, stats, lsp, mcp, telemetry, config",
			usage:
				"/diag [status|about|context|stats|lsp|mcp|telemetry|training|config]",
			tags: ["diagnostics"],
			aliases: ["d", "diagnostics"],
			examples: [
				"/diag",
				"/diag status",
				"/diag lsp",
				"/diag telemetry",
				"/diag config",
			],
		},
		subcommands: DIAG_SUBCOMMANDS,
	},
	[CommandSuiteKey.Ui]: {
		command: {
			name: "ui",
			description:
				"UI settings: theme, clean, footer, alerts, zen, compact-tools",
			usage: "/ui [theme|clean|footer|alerts|zen|compact]",
			tags: ["ui"],
			examples: ["/ui", "/ui theme", "/ui zen on", "/ui compact off"],
		},
		subcommands: UI_SUBCOMMANDS,
	},
	[CommandSuiteKey.Safety]: {
		command: {
			name: "safe",
			description: "Safety settings: approvals, plan-mode, guardian",
			usage: "/safe [approvals|plan|guardian] [args]",
			tags: ["safety"],
			examples: [
				"/safe",
				"/safe approvals auto",
				"/safe plan on",
				"/safe guardian run",
			],
		},
		subcommands: SAFETY_SUBCOMMANDS,
	},
	[CommandSuiteKey.Git]: {
		command: {
			name: "git",
			description: "Git operations: status, diff, review",
			usage: "/git [status|diff <path>|review]",
			tags: ["git"],
			examples: ["/git", "/git diff src/index.ts", "/git review"],
		},
		subcommands: GIT_SUBCOMMANDS,
	},
	[CommandSuiteKey.Auth]: {
		command: {
			name: "auth",
			description: "Authentication: login, logout, status, source-of-truth",
			usage: "/auth [login|logout|status|source-of-truth] [provider] [area]",
			tags: ["auth"],
			examples: [
				"/auth",
				"/auth login pro",
				"/auth logout",
				"/auth source-of-truth openai analytics",
			],
		},
		subcommands: AUTH_SUBCOMMANDS,
	},
	[CommandSuiteKey.Usage]: {
		command: {
			name: "usage",
			description: "Usage tracking: cost, quota, stats",
			usage: "/usage [cost|quota|stats] [args]",
			tags: ["usage"],
			examples: [
				"/usage",
				"/usage cost breakdown week",
				"/usage quota detailed",
			],
		},
		subcommands: USAGE_SUBCOMMANDS,
	},
	[CommandSuiteKey.Undo]: {
		command: {
			name: "undo",
			description: "Undo system: undo, checkpoint, changes, history",
			usage: "/undo [<N>|checkpoint|changes|history] [args]",
			tags: ["undo"],
			examples: [
				"/undo",
				"/undo 3",
				"/undo checkpoint save before-refactor",
				"/undo changes",
			],
		},
		subcommands: UNDO_SUBCOMMANDS,
	},
	[CommandSuiteKey.Config]: {
		command: {
			name: "cfg",
			description: "Configuration: validate, import, framework, composer, init",
			usage: "/cfg [validate|import|framework|composer|init] [args]",
			tags: ["config"],
			examples: [
				"/cfg",
				"/cfg validate",
				"/cfg import factory",
				"/cfg framework react",
				"/cfg composer code-reviewer",
			],
		},
		subcommands: CONFIG_SUBCOMMANDS,
	},
	[CommandSuiteKey.Tools]: {
		command: {
			name: "tools",
			description: "Tools: list, mcp, lsp, workflow, run, commands",
			usage: "/tools [list|mcp|lsp|workflow|run|commands] [args]",
			tags: ["tools"],
			aliases: ["t"],
			examples: [
				"/tools",
				"/tools list",
				"/tools mcp",
				"/tools lsp status",
				"/tools run test",
			],
		},
		subcommands: TOOLS_SUBCOMMANDS,
	},
};

export const COMMAND_SUITE_DEFINITIONS: readonly CommandSuiteDefinition[] =
	COMMAND_SUITE_ORDER.map((key) => ({
		key,
		...COMMAND_SUITE_CATALOG[key],
	}));
