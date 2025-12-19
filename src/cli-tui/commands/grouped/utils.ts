/**
 * Shared utilities for grouped command handlers.
 *
 * Provides consistent argument parsing and context rewriting
 * across all grouped command implementations.
 */

import type { AutocompleteItem } from "@evalops/tui";
import type { CommandExecutionContext } from "../types.js";

/**
 * Result of parsing subcommand arguments.
 */
export interface ParsedSubcommand {
	/** The subcommand name (first argument, lowercased) */
	subcommand: string;
	/** All arguments split by whitespace */
	args: string[];
	/** Creates a new context for delegating to another command */
	rewriteContext: (cmd: string) => CommandExecutionContext;
	/** Creates a context with custom raw input and argument text */
	customContext: (
		rawInput: string,
		argumentText: string,
	) => CommandExecutionContext;
}

/**
 * Parse subcommand arguments from a context with a default subcommand.
 *
 * @example
 * ```ts
 * const { subcommand, args, rewriteContext } = parseSubcommand(ctx, "status");
 * switch (subcommand) {
 *   case "status":
 *     deps.handleStatus();
 *     break;
 *   case "start":
 *     await deps.handleStart(rewriteContext("start"));
 *     break;
 * }
 * ```
 */
export function parseSubcommand(
	ctx: CommandExecutionContext,
	defaultSubcommand: string,
): ParsedSubcommand {
	const args = ctx.argumentText.trim().split(/\s+/);
	const subcommand = args[0]?.toLowerCase() || defaultSubcommand;

	const rewriteContext = (cmd: string): CommandExecutionContext => ({
		...ctx,
		rawInput: `/${cmd} ${args.slice(1).join(" ")}`.trim(),
		argumentText: args.slice(1).join(" "),
	});

	const customContext = (
		rawInput: string,
		argumentText: string,
	): CommandExecutionContext => ({
		...ctx,
		rawInput,
		argumentText,
	});

	return { subcommand, args, rewriteContext, customContext };
}

/**
 * Check if a string matches common help aliases.
 */
export function isHelpRequest(subcommand: string): boolean {
	return ["help", "?", "-h", "--help"].includes(subcommand);
}

/**
 * Check if a string looks like a numeric argument.
 */
export function isNumericArg(value: string): boolean {
	return /^\d+$/.test(value);
}

/**
 * Check if a string looks like a session ID (hex string or number).
 */
export function isSessionId(value: string): boolean {
	return /^[a-f0-9-]+$/i.test(value) || /^\d+$/.test(value);
}

/**
 * Common aliases for subcommands across handlers.
 */
export const COMMON_ALIASES = {
	status: ["status", "st", "info"],
	list: ["list", "ls", "all"],
	help: ["help", "?", "-h", "--help"],
	enable: ["enable", "on", "yes", "true", "1"],
	disable: ["disable", "off", "no", "false", "0"],
} as const;

/**
 * Check if a subcommand matches any of the given aliases.
 */
export function matchesAlias(
	subcommand: string,
	aliases: readonly string[],
): boolean {
	return aliases.includes(subcommand.toLowerCase());
}

/**
 * Subcommand definition for autocomplete.
 */
export interface SubcommandDef {
	name: string;
	description: string;
	aliases?: string[];
}

/**
 * Create an autocomplete provider for grouped command subcommands.
 *
 * @example
 * ```ts
 * const completions = createSubcommandCompletions([
 *   { name: "status", description: "Show status", aliases: ["st"] },
 *   { name: "list", description: "List items", aliases: ["ls"] },
 * ]);
 * // Use in command definition:
 * { name: "mygroup", getArgumentCompletions: completions }
 * ```
 */
export function createSubcommandCompletions(
	subcommands: SubcommandDef[],
): (prefix: string) => AutocompleteItem[] | null {
	return (prefix: string): AutocompleteItem[] | null => {
		const lowerPrefix = prefix.toLowerCase().trim();

		// If there's a space, we're past the subcommand - no completions
		if (lowerPrefix.includes(" ")) {
			return null;
		}

		// Filter subcommands matching the prefix
		const matches = subcommands.filter(
			(sub) =>
				sub.name.toLowerCase().startsWith(lowerPrefix) ||
				sub.aliases?.some((a) => a.toLowerCase().startsWith(lowerPrefix)),
		);

		if (matches.length === 0) {
			return null;
		}

		return matches.map((sub) => ({
			value: sub.name,
			label: sub.aliases?.length
				? `${sub.name} (${sub.aliases.join(", ")})`
				: sub.name,
			description: sub.description,
		}));
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Predefined subcommand completions for grouped commands
// ═══════════════════════════════════════════════════════════════════════════

export const SESSION_SUBCOMMANDS: SubcommandDef[] = [
	{
		name: "info",
		description: "Show current session info",
		aliases: ["status"],
	},
	{ name: "new", description: "Start a fresh chat session" },
	{ name: "clear", description: "Clear context and start fresh" },
	{
		name: "list",
		description: "List recent sessions",
		aliases: ["ls", "history"],
	},
	{ name: "load", description: "Load a session by ID" },
	{ name: "branch", description: "Branch from user message n" },
	{ name: "queue", description: "Show/manage message queue" },
	{ name: "export", description: "Export session to file" },
	{ name: "share", description: "Generate shareable HTML" },
	{ name: "favorite", description: "Mark as favorite", aliases: ["fav"] },
	{
		name: "unfavorite",
		description: "Remove favorite mark",
		aliases: ["unfav"],
	},
	{
		name: "summary",
		description: "Add manual summary",
		aliases: ["summarize"],
	},
];

export const DIAG_SUBCOMMANDS: SubcommandDef[] = [
	{ name: "status", description: "Health snapshot", aliases: ["health"] },
	{
		name: "about",
		description: "Build and version info",
		aliases: ["version", "info"],
	},
	{
		name: "context",
		description: "Token usage visualization",
		aliases: ["tokens"],
	},
	{
		name: "stats",
		description: "Combined status and cost",
		aliases: ["overview"],
	},
	{
		name: "background",
		description: "Background task config",
		aliases: ["bg"],
	},
	{ name: "lsp", description: "LSP server status" },
	{ name: "mcp", description: "MCP server status" },
	{ name: "keys", description: "API key status", aliases: ["api"] },
	{ name: "telemetry", description: "Telemetry status", aliases: ["telem"] },
	{ name: "training", description: "Training preference", aliases: ["train"] },
	{
		name: "otel",
		description: "OpenTelemetry config",
		aliases: ["opentelemetry"],
	},
	{ name: "config", description: "Configuration validation", aliases: ["cfg"] },
	{ name: "pii", description: "PII detection patterns" },
	{ name: "access", description: "Directory access rules" },
	{ name: "audit", description: "Audit log (enterprise)" },
	{ name: "bedrock", description: "AWS Bedrock status", aliases: ["aws"] },
];

export const ACCESS_SUBCOMMANDS: SubcommandDef[] = [
	{ name: "safe", description: "Safe roots for file writes" },
	{
		name: "restricted",
		description: "System-protected paths",
		aliases: ["blocked"],
	},
	{ name: "test", description: "Test a path against containment rules" },
];

export const UI_SUBCOMMANDS: SubcommandDef[] = [
	{
		name: "status",
		description: "Show current UI settings",
		aliases: ["info"],
	},
	{
		name: "theme",
		description: "Open theme selector",
		aliases: ["color", "colors"],
	},
	{ name: "clean", description: "Text deduplication mode", aliases: ["dedup"] },
	{ name: "footer", description: "Footer style" },
	{
		name: "alerts",
		description: "Alert management",
		aliases: ["notifications"],
	},
	{ name: "zen", description: "Toggle zen mode" },
	{
		name: "compact",
		description: "Toggle tool output folding",
		aliases: ["fold"],
	},
];

export const SAFETY_SUBCOMMANDS: SubcommandDef[] = [
	{ name: "status", description: "Show safety settings", aliases: ["info"] },
	{
		name: "approvals",
		description: "Set approval mode",
		aliases: ["approval", "approve"],
	},
	{
		name: "plan",
		description: "Toggle plan mode",
		aliases: ["plan-mode", "planmode"],
	},
	{
		name: "guardian",
		description: "Guardian scanning",
		aliases: ["guard", "scan"],
	},
];

export const GIT_SUBCOMMANDS: SubcommandDef[] = [
	{ name: "status", description: "Show git status", aliases: ["st"] },
	{ name: "diff", description: "Show diff for file", aliases: ["d"] },
	{
		name: "review",
		description: "Summarize status and diff",
		aliases: ["summary"],
	},
];

export const AUTH_SUBCOMMANDS: SubcommandDef[] = [
	{
		name: "status",
		description: "Show auth status",
		aliases: ["info", "whoami"],
	},
	{ name: "login", description: "Authenticate", aliases: ["signin"] },
	{ name: "logout", description: "Remove credentials", aliases: ["signout"] },
];

export const USAGE_SUBCOMMANDS: SubcommandDef[] = [
	{
		name: "overview",
		description: "Show usage overview",
		aliases: ["summary"],
	},
	{
		name: "cost",
		description: "Show cost summary",
		aliases: ["costs", "spend"],
	},
	{
		name: "quota",
		description: "Show token quota",
		aliases: ["tokens", "limit", "limits"],
	},
	{ name: "stats", description: "Combined status and cost", aliases: ["all"] },
];

export const UNDO_SUBCOMMANDS: SubcommandDef[] = [
	{
		name: "undo",
		description: "Undo last action",
		aliases: ["back", "revert"],
	},
	{
		name: "checkpoint",
		description: "Create/restore checkpoint",
		aliases: ["save", "snap", "snapshot"],
	},
	{
		name: "changes",
		description: "List tracked file changes",
		aliases: ["files", "tracked"],
	},
	{
		name: "history",
		description: "Show undo status",
		aliases: ["list", "status"],
	},
];

export const CONFIG_SUBCOMMANDS: SubcommandDef[] = [
	{
		name: "validate",
		description: "Validate configuration",
		aliases: ["check", "status"],
	},
	{ name: "sources", description: "Show config sources" },
	{ name: "providers", description: "Show provider configuration" },
	{ name: "env", description: "Show environment variables" },
	{
		name: "import",
		description: "Import configuration presets",
		aliases: ["preset", "presets"],
	},
	{
		name: "framework",
		description: "Set/show default framework",
		aliases: ["fw"],
	},
	{
		name: "composer",
		description: "Manage custom composer configs",
		aliases: ["persona", "agent"],
	},
	{
		name: "init",
		description: "Create AGENTS.md scaffolding",
		aliases: ["scaffold", "setup"],
	},
];

export const TOOLS_SUBCOMMANDS: SubcommandDef[] = [
	{
		name: "list",
		description: "List all tools",
		aliases: ["all", "available"],
	},
	{
		name: "failures",
		description: "Show tool failures",
		aliases: ["errors", "failed"],
	},
	{ name: "clear", description: "Clear tool logs", aliases: ["reset"] },
	{ name: "mcp", description: "Show MCP servers", aliases: ["servers"] },
	{ name: "lsp", description: "LSP server management", aliases: ["language"] },
	{
		name: "workflow",
		description: "Run workflows",
		aliases: ["workflows", "wf"],
	},
	{ name: "run", description: "Run npm scripts", aliases: ["script", "npm"] },
	{
		name: "commands",
		description: "User command management",
		aliases: ["cmd", "user"],
	},
];
