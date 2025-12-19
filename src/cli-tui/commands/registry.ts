import type { SlashCommand } from "@evalops/tui";
import { parseCommandArguments, shouldShowHelp } from "./argument-parser.js";
import {
	AUTH_SUBCOMMANDS,
	CONFIG_SUBCOMMANDS,
	DIAG_SUBCOMMANDS,
	GIT_SUBCOMMANDS,
	SAFETY_SUBCOMMANDS,
	SESSION_SUBCOMMANDS,
	TOOLS_SUBCOMMANDS,
	UI_SUBCOMMANDS,
	UNDO_SUBCOMMANDS,
	USAGE_SUBCOMMANDS,
	createSubcommandCompletions,
} from "./grouped/index.js";
import type {
	CommandEntry,
	CommandExecutionContext,
	CommandRegistryOptions,
} from "./types.js";

const equals =
	(name: string, aliases: string[] = []) =>
	(input: string) =>
		input === `/${name}` || aliases.some((a) => input === `/${a}`);

const withArgs =
	(name: string, aliases: string[] = []) =>
	(input: string) =>
		input === `/${name}` ||
		input.startsWith(`/${name} `) ||
		aliases.some((a) => input === `/${a}` || input.startsWith(`/${a} `));

const matchDiagnostics = (input: string) =>
	input === "/diag" ||
	input.startsWith("/diag ") ||
	input === "/diagnostics" ||
	input === "/d" ||
	input.startsWith("/d ");

const matchQuit = (input: string) =>
	input === "/quit" || input === "/exit" || input === "/q";

export function createCommandRegistry({
	getRunScriptCompletions,
	handlers,
	createContext,
}: CommandRegistryOptions): CommandEntry[] {
	const entries: CommandEntry[] = [
		buildEntry(
			{
				name: "zen",
				description: "Toggle Zen Mode (hides header, ensures minimal footer)",
				usage: "/zen [on|off]",
				tags: ["ui"],
				examples: ["/zen", "/zen on", "/zen off"],
			},
			withArgs("zen"),
			handlers.zen,
			createContext,
		),
		buildEntry(
			{
				name: "context",
				description: "Visualize context usage (tokens per message/file)",
				usage: "/context",
				tags: ["diagnostics", "usage"],
			},
			equals("context"),
			handlers.context,
			createContext,
		),
		buildEntry(
			{
				name: "approvals",
				description:
					"Show approval status or switch between auto/prompt/fail modes",
				usage: "/approvals [auto|prompt|fail]",
				tags: ["safety"],
			},
			withArgs("approvals"),
			handlers.approvals,
			createContext,
		),
		buildEntry(
			{
				name: "plan-mode",
				description: "Toggle plan mode (ask before write/edit/bash)",
				usage: "/plan-mode [on|off]",
				tags: ["safety"],
			},
			withArgs("plan-mode"),
			handlers.planMode,
			createContext,
		),
		buildEntry(
			{
				name: "guardian",
				description:
					"Run Composer Guardian (Semgrep + secrets) or toggle enforcement",
				usage: "/guardian [run|status|enable|disable|all]",
				tags: ["safety", "git"],
				examples: ["/guardian", "/guardian status", "/guardian disable"],
			},
			withArgs("guardian"),
			handlers.guardian,
			createContext,
		),
		buildEntry(
			{
				name: "workflow",
				description: "Run declarative multi-step tool workflows",
				usage: "/workflow [list|run|validate|show] [name]",
				tags: ["tools", "automation"],
				arguments: [
					{
						name: "subcommand",
						type: "enum",
						required: false,
						description: "Workflow subcommand",
						choices: ["list", "run", "validate", "show"],
					},
					{
						name: "name",
						type: "string",
						required: false,
						description: "Workflow name",
					},
				],
				examples: [
					"/workflow",
					"/workflow list",
					"/workflow run setup-project",
					"/workflow validate my-workflow",
					"/workflow show my-workflow",
				],
			},
			withArgs("workflow"),
			handlers.workflow,
			createContext,
		),
		buildEntry(
			{
				name: "framework",
				description:
					"Set or show default framework (supports --workspace and list)",
				usage: "/framework [id|none|list] [--workspace]",
				tags: ["session"],
			},
			withArgs("framework"),
			handlers.framework,
			createContext,
		),
		buildEntry(
			{
				name: "commands",
				description: "List or run user commands from .composer/commands",
				usage: "/commands list | /commands run <name> [k=v]...",
				tags: ["session", "automation"],
			},
			withArgs("commands"),
			handlers.commands,
			createContext,
		),
		buildEntry(
			{
				name: "report",
				description: "Collect info for bug reports or general feedback",
				usage: "/report [bug|feedback]",
				tags: ["support"],
				arguments: [
					{
						name: "type",
						type: "enum",
						required: false,
						description: "Select report type",
						choices: ["bug", "feedback"],
					},
				],
				examples: ["/report", "/report bug", "/report feedback"],
			},
			withArgs("report"),
			handlers.report,
			createContext,
		),
		buildEntry(
			{
				name: "thinking",
				description: "Adjust reasoning level for supported models",
				usage: "/thinking [off|minimal|low|medium|high]",
				tags: ["session"],
				arguments: [
					{
						name: "level",
						type: "enum",
						required: false,
						description: "Thinking level to set",
						choices: ["off", "minimal", "low", "medium", "high"],
					},
				],
				examples: ["/thinking", "/thinking medium", "/thinking off"],
			},
			withArgs("thinking"),
			handlers.thinking,
			createContext,
		),
		buildEntry(
			{
				name: "model",
				description: "Select model (opens selector UI)",
				usage: "/model",
				tags: ["session"],
			},
			equals("model"),
			handlers.model,
			createContext,
		),
		buildEntry(
			{
				name: "mode",
				description: "Switch agent mode (smart/rush/free)",
				usage: "/mode [smart|rush|free|list|suggest]",
				tags: ["session", "model"],
				examples: ["/mode", "/mode smart", "/mode rush", "/mode free"],
			},
			withArgs("mode"),
			handlers.mode,
			createContext,
		),
		buildEntry(
			{
				name: "theme",
				description: "Select color theme (opens selector with live preview)",
				usage: "/theme",
				tags: ["ui"],
			},
			equals("theme"),
			handlers.theme,
			createContext,
		),
		buildEntry(
			{
				name: "clean",
				description:
					"Toggle assistant text deduplication during live streaming only",
				usage: "/clean [off|soft|aggressive]",
				tags: ["ui"],
				examples: ["/clean", "/clean soft", "/clean off"],
			},
			withArgs("clean"),
			handlers.clean,
			createContext,
		),
		buildEntry(
			{
				name: "new",
				description: "Start a fresh chat session",
				usage: "/new",
				tags: ["session"],
			},
			equals("new"),
			handlers.newChat,
			createContext,
		),
		buildEntry(
			{
				name: "export",
				description: "Export session to HTML or text",
				usage: "/export [path] [html|text]",
				tags: ["session", "sharing"],
				aliases: ["e"],
			},
			withArgs("export", ["e"]),
			handlers.exportSession,
			createContext,
		),
		buildEntry(
			{
				name: "share",
				description: "Generate a self-contained HTML share link",
				usage: "/share [output.html]",
				tags: ["session", "sharing"],
			},
			withArgs("share"),
			handlers.shareSession,
			createContext,
		),
		// ═══════════════════════════════════════════════════════════════════
		// STANDALONE COMMANDS - These are also available as grouped subcommands
		// (e.g., /import is also /cfg import, /mcp is also /tools mcp)
		// Keep for backwards compatibility and discoverability
		// ═══════════════════════════════════════════════════════════════════
		buildEntry(
			{
				name: "import",
				description: "Import configuration (e.g. Factory presets)",
				usage: "/import factory",
				tags: ["config"],
			},
			withArgs("import"),
			handlers.importConfig,
			createContext,
		),
		buildEntry(
			{
				name: "session",
				description:
					"Show session info, mark favorite, or add a manual summary",
				usage:
					'/session [info|favorite|unfavorite|summary "text"] (defaults: info)',
				tags: ["session"],
				aliases: ["s"],
			},
			withArgs("session", ["s"]),
			handlers.session,
			createContext,
		),
		buildEntry(
			{
				name: "sessions",
				description:
					"List, load, favorite, or summarize recent sessions by index",
				usage:
					"/sessions [list|load <id>|favorite <id>|unfavorite <id>|summarize <id>]",
				tags: ["session"],
				aliases: ["ss"],
			},
			withArgs("sessions", ["ss"]),
			handlers.sessions,
			createContext,
		),
		buildEntry(
			{
				name: "branch",
				description:
					"Create a new session from an earlier user message (keeps history up to that point)",
				usage: "/branch [list|<user-message-number>]",
				tags: ["session"],
			},
			withArgs("branch"),
			handlers.branch,
			createContext,
		),
		buildEntry(
			{
				name: "queue",
				description: "List, cancel, or change queue mode",
				usage: "/queue [list|cancel <id>|mode <one|all>]",
				tags: ["session"],
			},
			withArgs("queue"),
			handlers.queue,
			createContext,
		),
		buildEntry(
			{
				name: "about",
				description: "Show Composer build, env, and git info",
				usage: "/about",
				tags: ["system", "diagnostics"],
			},
			equals("about"),
			handlers.about,
			createContext,
		),
		buildEntry(
			{
				name: "clear",
				description: "Clear context and start a fresh session",
				usage: "/clear",
				tags: ["session"],
			},
			equals("clear"),
			handlers.clear,
			createContext,
		),
		buildEntry(
			{
				name: "plan",
				description: "Show saved plans/checklists",
				usage: "/plan [id]",
				tags: ["planning"],
				aliases: ["p"],
			},
			withArgs("plan", ["p"]),
			handlers.plan,
			createContext,
		),
		buildEntry(
			{
				name: "init",
				description: "Create or overwrite AGENTS.md scaffolding for this repo",
				usage: "/init [path]",
				tags: ["config"],
			},
			withArgs("init"),
			handlers.initAgents,
			createContext,
		),
		buildEntry(
			{
				name: "diff",
				description: "Show git diff for a file",
				usage: "/diff <path>",
				tags: ["git"],
			},
			withArgs("diff"),
			handlers.preview,
			createContext,
		),
		buildEntry(
			{
				name: "status",
				description:
					"Show health snapshot (model, git, plan, telemetry, training)",
				usage: "/status",
				tags: ["diagnostics"],
			},
			equals("status"),
			handlers.status,
			createContext,
		),
		buildEntry(
			{
				name: "background",
				description:
					"Configure background task notifications and status redaction",
				usage:
					"/background [status|notify <on|off>|details <on|off>|history|path]",
				tags: ["diagnostics"],
				examples: [
					"/background",
					"/background notify on",
					"/background details on",
					"/background history",
					"/background path",
				],
			},
			withArgs("background"),
			handlers.background,
			createContext,
		),
		buildEntry(
			{
				name: "review",
				description: "Summarize git status and diff stats",
				usage: "/review",
				tags: ["git"],
			},
			equals("review"),
			handlers.review,
			createContext,
		),
		buildEntry(
			{
				name: "undo",
				description: "Undo last N file changes (beyond git) with preview",
				usage: "/undo [N] [--preview] [--force]",
				tags: ["undo", "safety"],
				arguments: [
					{
						name: "count",
						type: "number",
						required: false,
						description: "Number of changes to undo (default: 1)",
					},
				],
				examples: ["/undo", "/undo 3", "/undo --preview", "/undo 2 --force"],
			},
			withArgs("undo"),
			handlers.undoChanges,
			createContext,
		),
		buildEntry(
			{
				name: "changes",
				description: "List tracked file changes from this session",
				usage: "/changes [--files|--tools]",
				tags: ["undo", "diagnostics"],
				examples: ["/changes", "/changes --files", "/changes --tools"],
			},
			withArgs("changes"),
			handlers.changes,
			createContext,
		),
		buildEntry(
			{
				name: "checkpoint",
				description: "Save/restore named checkpoints for rollback",
				usage: "/checkpoint [save|list|restore] [name]",
				tags: ["undo", "safety"],
				arguments: [
					{
						name: "subcommand",
						type: "enum",
						required: false,
						description: "Checkpoint subcommand",
						choices: ["save", "list", "restore"],
					},
					{
						name: "name",
						type: "string",
						required: false,
						description: "Checkpoint name",
					},
				],
				examples: [
					"/checkpoint",
					"/checkpoint save before-refactor",
					"/checkpoint list",
					"/checkpoint restore before-refactor",
				],
			},
			withArgs("checkpoint"),
			handlers.checkpoint,
			createContext,
		),
		buildEntry(
			{
				name: "memory",
				description: "Cross-session memory for facts and learnings",
				usage: "/memory [save|search|list|delete|stats|export|import|clear]",
				tags: ["memory", "session"],
				arguments: [
					{
						name: "subcommand",
						type: "enum",
						required: false,
						description: "Memory subcommand",
						choices: [
							"save",
							"search",
							"list",
							"delete",
							"stats",
							"export",
							"import",
							"clear",
							"recent",
						],
					},
				],
				examples: [
					"/memory",
					"/memory save api-design Use REST conventions #rest",
					"/memory search REST",
					"/memory list",
					"/memory list api-design",
					"/memory stats",
				],
			},
			withArgs("memory"),
			handlers.memory,
			createContext,
		),
		buildEntry(
			{
				name: "mention",
				description: "Search files to mention (same as @ search)",
				usage: "/mention <query>",
				tags: ["search"],
			},
			withArgs("mention"),
			handlers.mention,
			createContext,
		),
		buildEntry(
			{
				name: "run",
				description: "Run npm script (e.g. /run test --watch)",
				usage: "/run <script> [--flags]",
				tags: ["automation"],
				aliases: ["r"],
				getArgumentCompletions: getRunScriptCompletions,
			},
			withArgs("run", ["r"]),
			handlers.run,
			createContext,
		),
		buildEntry(
			{
				name: "ollama",
				description: "Control local Ollama models (list, pull, ps)",
				usage: "/ollama [list|pull <model>|ps]",
				tags: ["local", "models"],
				examples: ["/ollama list", "/ollama pull llama3", "/ollama ps"],
			},
			withArgs("ollama"),
			handlers.ollama,
			createContext,
		),
		buildEntry(
			{
				name: "help",
				description: "List available slash commands",
				usage: "/help",
				tags: ["support"],
				aliases: ["h"],
			},
			equals("help", ["h"]),
			handlers.help,
			createContext,
		),
		buildEntry(
			{
				name: "update",
				description: "Check for Composer CLI updates",
				usage: "/update",
				tags: ["system"],
			},
			equals("update"),
			handlers.update,
			createContext,
		),
		buildEntry(
			{
				name: "changelog",
				description: "Display full version history",
				usage: "/changelog",
				tags: ["system"],
			},
			equals("changelog"),
			handlers.changelog,
			createContext,
		),
		buildEntry(
			{
				name: "hotkeys",
				description: "Show all keyboard shortcuts",
				usage: "/hotkeys",
				tags: ["help"],
				aliases: ["keys", "shortcuts"],
			},
			equals("hotkeys", ["keys", "shortcuts"]),
			handlers.hotkeys,
			createContext,
		),
		buildEntry(
			{
				name: "telemetry",
				description: "Show telemetry status or toggle runtime overrides",
				usage: "/telemetry [status|on|off|reset]",
				tags: ["diagnostics", "telemetry"],
				arguments: [
					{
						name: "action",
						type: "enum",
						required: false,
						description: "Action to perform",
						choices: ["status", "on", "off", "reset"],
					},
				],
				examples: ["/telemetry", "/telemetry off"],
			},
			withArgs("telemetry"),
			handlers.telemetry,
			createContext,
		),
		buildEntry(
			{
				name: "otel",
				description: "Show OpenTelemetry runtime configuration",
				usage: "/otel",
				tags: ["diagnostics", "telemetry"],
			},
			equals("otel"),
			handlers.otel,
			createContext,
		),
		buildEntry(
			{
				name: "training",
				description: "Toggle model training preference or show status",
				usage: "/training [status|on|off|reset]",
				tags: ["privacy"],
				arguments: [
					{
						name: "action",
						type: "enum",
						required: false,
						description: "Training action",
						choices: ["status", "on", "off", "reset"],
					},
				],
				examples: ["/training", "/training off"],
			},
			withArgs("training"),
			handlers.training,
			createContext,
		),
		buildEntry(
			{
				name: "config",
				description: "Validate and inspect Composer configuration",
				usage: "/config [summary|sources|providers|env|files|help]",
				tags: ["config"],
				examples: ["/config", "/config sources"],
			},
			equals("config"),
			handlers.config,
			createContext,
		),
		buildEntry(
			{
				name: "cost",
				description: "Show usage and cost summary",
				usage: "/cost [period|breakdown <period>|clear|help]",
				tags: ["usage"],
				examples: ["/cost", "/cost breakdown week"],
			},
			withArgs("cost"),
			handlers.cost,
			createContext,
		),
		buildEntry(
			{
				name: "quota",
				description: "Show token quota status and usage limits",
				usage: "/quota [detailed|models|alerts|limit <tokens>|help]",
				tags: ["usage"],
				examples: [
					"/quota",
					"/quota detailed",
					"/quota models",
					"/quota limit 100000",
				],
			},
			withArgs("quota"),
			handlers.quota,
			createContext,
		),
		buildEntry(
			{
				name: "stats",
				description: "Show combined status and cost overview",
				usage: "/stats",
				tags: ["diagnostics", "usage"],
			},
			equals("stats"),
			handlers.stats,
			createContext,
		),
		buildEntry(
			{
				name: "diag",
				description: "Show provider/model/API key diagnostics",
				usage: "/diag [lsp|keys]",
				tags: ["diagnostics"],
				aliases: ["d", "diagnostics"],
			},
			matchDiagnostics,
			handlers.diagnostics,
			createContext,
		),
		buildEntry(
			{
				name: "mcp",
				description: "Show configured Model Context Protocol servers",
				usage: "/mcp",
				tags: ["tools"],
			},
			equals("mcp"),
			handlers.mcp,
			createContext,
		),
		buildEntry(
			{
				name: "lsp",
				description: "Manage Language Server Protocol servers",
				usage: "/lsp [status|start|stop|restart|detect]",
				tags: ["tools", "diagnostics"],
				examples: [
					"/lsp",
					"/lsp status",
					"/lsp start",
					"/lsp stop",
					"/lsp restart",
					"/lsp detect",
				],
			},
			withArgs("lsp"),
			handlers.lsp,
			createContext,
		),
		buildEntry(
			{
				name: "composer",
				description: "Manage custom composer configurations",
				usage: "/composer [list|<name>|activate <name>|deactivate]",
				tags: ["config"],
				examples: [
					"/composer",
					"/composer list",
					"/composer code-reviewer",
					"/composer activate code-reviewer",
					"/composer deactivate",
				],
			},
			withArgs("composer"),
			handlers.composer,
			createContext,
		),

		buildEntry(
			{
				name: "prompts",
				description:
					"List/run prompt templates from markdown files (~/.composer/prompts/, .composer/prompts/).",
				usage: "/prompts [list|<name> [args]]",
				tags: ["automation", "session"],
				examples: [
					"/prompts",
					"/prompts list",
					"/prompts review FILE=src/main.ts",
					"/pr-review FILE=src/main.ts",
					'/prompts ticket TICKET_ID=123 TITLE="Fix bug"',
				],
			},
			withArgs("prompts"),
			handlers.prompts,
			createContext,
		),
		buildEntry(
			{
				name: "compact",
				description: "Summarize older messages to reclaim context",
				usage: "/compact [custom instructions]",
				tags: ["planning"],
				examples: [
					"/compact",
					"/compact Focus on the API changes",
					"/compact Emphasize database migrations",
				],
			},
			withArgs("compact"),
			handlers.compact,
			createContext,
		),
		buildEntry(
			{
				name: "autocompact",
				description: "Toggle or configure auto-compaction",
				usage: "/autocompact [on|off|status]",
				tags: ["planning"],
				examples: [
					"/autocompact",
					"/autocompact on",
					"/autocompact off",
					"/autocompact status",
				],
			},
			withArgs("autocompact"),
			handlers.autocompact,
			createContext,
		),
		buildEntry(
			{
				name: "footer",
				description: "Switch footer style or view/clear footer alerts",
				usage: "/footer [ensemble|solo|history|clear]",
				tags: ["ui"],
				examples: [
					"/footer",
					"/footer solo",
					"/footer history",
					"/footer clear",
				],
			},
			withArgs("footer"),
			handlers.footer,
			createContext,
		),
		buildEntry(
			{
				name: "alerts",
				description: "Alias for footer alerts (history|clear)",
				usage: "/alerts [history|clear]",
				tags: ["ui"],
				examples: ["/alerts history", "/alerts clear"],
			},
			withArgs("alerts"),
			(context) => {
				context.rawInput = context.rawInput.replace(/^\/alerts/, "/footer");
				context.argumentText = context.argumentText.replace(
					/^alerts/,
					"footer",
				);
				handlers.footer(context);
			},
			createContext,
		),
		buildEntry(
			{
				name: "compact-tools",
				description: "Toggle folding of tool outputs",
				usage: "/compact-tools [on|off]",
				tags: ["tools"],
			},
			withArgs("compact-tools"),
			handlers.compactTools,
			createContext,
		),
		buildEntry(
			{
				name: "login",
				description: "Authenticate with Claude Pro/Max via OAuth",
				usage: "/login [mode] or /login [provider:mode]",
				tags: ["auth"],
				arguments: [
					{
						name: "argument",
						type: "string",
						required: false,
						description:
							"Login mode (pro/console) or provider:mode format (e.g., anthropic:pro)",
					},
				],
				examples: [
					"/login",
					"/login pro",
					"/login console",
					"/login anthropic:pro",
				],
			},
			withArgs("login"),
			handlers.login,
			createContext,
		),
		buildEntry(
			{
				name: "logout",
				description: "Remove stored Claude OAuth credentials",
				usage: "/logout [provider]",
				tags: ["auth"],
				arguments: [
					{
						name: "provider",
						type: "string",
						required: false,
						description: "OAuth provider to logout from (optional)",
					},
				],
				examples: ["/logout", "/logout anthropic"],
			},
			withArgs("logout"),
			handlers.logout,
			createContext,
		),
		buildEntry(
			{
				name: "quit",
				description: "Exit composer (same as ctrl+c twice)",
				usage: "/quit",
				tags: ["system"],
				aliases: ["q", "exit"],
			},
			matchQuit,
			handlers.quit,
			createContext,
		),
		buildEntry(
			{
				name: "copy",
				description: "Copy last assistant message to clipboard",
				usage: "/copy",
				tags: ["session"],
			},
			equals("copy"),
			handlers.copy,
			createContext,
		),

		// ═══════════════════════════════════════════════════════════════════
		// GROUPED COMMANDS - Organize related commands under parent commands
		// ═══════════════════════════════════════════════════════════════════

		buildEntry(
			{
				name: "ss",
				description:
					"Session management: new, clear, list, load, branch, export, share",
				usage:
					"/ss [new|clear|list|load <id>|branch <n>|export|share|queue|info]",
				tags: ["session"],
				examples: [
					"/ss",
					"/ss new",
					"/ss list",
					"/ss load 3",
					"/ss branch 2",
					"/ss export",
				],
				getArgumentCompletions:
					createSubcommandCompletions(SESSION_SUBCOMMANDS),
			},
			withArgs("ss"),
			handlers.sessionCommand,
			createContext,
		),
		buildEntry(
			{
				name: "diag",
				description:
					"Diagnostics: status, about, context, stats, lsp, mcp, telemetry, config",
				usage:
					"/diag [status|about|context|stats|lsp|mcp|telemetry|training|config]",
				tags: ["diagnostics"],
				examples: [
					"/diag",
					"/diag status",
					"/diag lsp",
					"/diag telemetry",
					"/diag config",
				],
				getArgumentCompletions: createSubcommandCompletions(DIAG_SUBCOMMANDS),
			},
			withArgs("diag"),
			handlers.diagCommand,
			createContext,
		),
		buildEntry(
			{
				name: "ui",
				description:
					"UI settings: theme, clean, footer, alerts, zen, compact-tools",
				usage: "/ui [theme|clean|footer|alerts|zen|compact]",
				tags: ["ui"],
				examples: ["/ui", "/ui theme", "/ui zen on", "/ui compact off"],
				getArgumentCompletions: createSubcommandCompletions(UI_SUBCOMMANDS),
			},
			withArgs("ui"),
			handlers.uiCommand,
			createContext,
		),
		buildEntry(
			{
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
				getArgumentCompletions: createSubcommandCompletions(SAFETY_SUBCOMMANDS),
			},
			withArgs("safe"),
			handlers.safetyCommand,
			createContext,
		),
		buildEntry(
			{
				name: "git",
				description: "Git operations: status, diff, review",
				usage: "/git [status|diff <path>|review]",
				tags: ["git"],
				examples: ["/git", "/git diff src/index.ts", "/git review"],
				getArgumentCompletions: createSubcommandCompletions(GIT_SUBCOMMANDS),
			},
			withArgs("git"),
			handlers.gitCommand,
			createContext,
		),
		buildEntry(
			{
				name: "auth",
				description: "Authentication: login, logout, status",
				usage: "/auth [login|logout|status] [mode]",
				tags: ["auth"],
				examples: ["/auth", "/auth login pro", "/auth logout"],
				getArgumentCompletions: createSubcommandCompletions(AUTH_SUBCOMMANDS),
			},
			withArgs("auth"),
			handlers.authCommand,
			createContext,
		),
		buildEntry(
			{
				name: "usage",
				description: "Usage tracking: cost, quota, stats",
				usage: "/usage [cost|quota|stats] [args]",
				tags: ["usage"],
				examples: [
					"/usage",
					"/usage cost breakdown week",
					"/usage quota detailed",
				],
				getArgumentCompletions: createSubcommandCompletions(USAGE_SUBCOMMANDS),
			},
			withArgs("usage"),
			handlers.usageCommand,
			createContext,
		),
		buildEntry(
			{
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
				getArgumentCompletions: createSubcommandCompletions(UNDO_SUBCOMMANDS),
			},
			withArgs("undo"),
			handlers.undoCommand,
			createContext,
		),
		buildEntry(
			{
				name: "cfg",
				description:
					"Configuration: validate, import, framework, composer, init",
				usage: "/cfg [validate|import|framework|composer|init] [args]",
				tags: ["config"],
				examples: [
					"/cfg",
					"/cfg validate",
					"/cfg import factory",
					"/cfg framework react",
					"/cfg composer code-reviewer",
				],
				getArgumentCompletions: createSubcommandCompletions(CONFIG_SUBCOMMANDS),
			},
			withArgs("cfg"),
			handlers.configCommand,
			createContext,
		),
		buildEntry(
			{
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
				getArgumentCompletions: createSubcommandCompletions(TOOLS_SUBCOMMANDS),
			},
			withArgs("tools", ["t"]),
			handlers.toolsCommand,
			createContext,
		),
	];

	return entries;
}

function buildEntry(
	command: SlashCommand,
	matches: (input: string) => boolean,
	handler: (context: CommandExecutionContext) => void | Promise<void>,
	createContext: CommandRegistryOptions["createContext"],
): CommandEntry {
	return {
		command,
		matches,
		execute: (input: string) =>
			executeCommand(command, input, handler, createContext),
	};
}

function executeCommand(
	command: SlashCommand,
	rawInput: string,
	handler: (context: CommandExecutionContext) => void | Promise<void>,
	createContext: CommandRegistryOptions["createContext"],
): void | Promise<void> {
	const argumentText = extractArgumentText(rawInput);
	if (shouldShowHelp(argumentText)) {
		const context = createContext({ command, rawInput, argumentText });
		context.renderHelp();
		return;
	}
	const parseResult = parseCommandArguments(argumentText, command.arguments);
	if (!parseResult.ok) {
		const context = createContext({ command, rawInput, argumentText });
		context.showError(
			"errors" in parseResult ? parseResult.errors.join(" ") : "Parse error",
		);
		context.renderHelp();
		return;
	}
	const context = createContext({
		command,
		rawInput,
		argumentText,
		parsedArgs: parseResult.args,
	});
	return handler(context);
}

function extractArgumentText(input: string): string {
	const spaceIndex = input.indexOf(" ");
	if (spaceIndex === -1) {
		return "";
	}
	return input.slice(spaceIndex + 1).trim();
}
