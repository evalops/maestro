import type { SlashCommand } from "@evalops/tui";
import type { CommandHandlers } from "./types.js";

export enum CommandMatchKind {
	Exact = "exact",
	WithArgs = "with-args",
	Diagnostics = "diagnostics",
	Quit = "quit",
}

export enum CommandCompletionKind {
	Access = "access",
	Hotkeys = "hotkeys",
	Package = "package",
	RunScripts = "run-scripts",
}

type CommandCatalogRuntimeFields = {
	handlerKey: keyof CommandHandlers;
	matchKind: CommandMatchKind;
	matchAliases?: readonly string[];
	completions?: CommandCompletionKind;
	rewriteTo?: string;
};

type CommandMetadata = Omit<SlashCommand, "name" | "getArgumentCompletions">;

export type CommandCatalogEntry = CommandMetadata &
	CommandCatalogRuntimeFields & {
		name: SlashCommand["name"];
	};

type CatalogCommandOptions = Omit<
	CommandCatalogRuntimeFields,
	"handlerKey" | "matchKind"
>;

type DefineCatalogCommand = (
	name: SlashCommand["name"],
	handlerKey: keyof CommandHandlers,
	metadata: CommandMetadata,
	options?: CatalogCommandOptions,
) => CommandCatalogEntry;

function defineCommand(
	matchKind: CommandMatchKind,
	name: SlashCommand["name"],
	handlerKey: keyof CommandHandlers,
	metadata: CommandMetadata,
	options: CatalogCommandOptions = {},
): CommandCatalogEntry {
	return {
		name,
		...metadata,
		handlerKey,
		matchKind,
		...options,
	};
}

const exact: DefineCatalogCommand = (name, handlerKey, metadata, options) =>
	defineCommand(CommandMatchKind.Exact, name, handlerKey, metadata, options);

const withArgs: DefineCatalogCommand = (name, handlerKey, metadata, options) =>
	defineCommand(CommandMatchKind.WithArgs, name, handlerKey, metadata, options);

const diagnostics: DefineCatalogCommand = (
	name,
	handlerKey,
	metadata,
	options,
) =>
	defineCommand(
		CommandMatchKind.Diagnostics,
		name,
		handlerKey,
		metadata,
		options,
	);

const quit: DefineCatalogCommand = (name, handlerKey, metadata, options) =>
	defineCommand(CommandMatchKind.Quit, name, handlerKey, metadata, options);

export const PRIMARY_COMMAND_CATALOG: readonly CommandCatalogEntry[] = [
	withArgs("zen", "zen", {
		description: "Toggle Zen Mode (hides header, ensures minimal footer)",
		usage: "/zen [on|off]",
		tags: ["ui"],
		examples: ["/zen", "/zen on", "/zen off"],
	}),
	exact("context", "context", {
		description: "Visualize context usage (tokens per message/file)",
		usage: "/context",
		tags: ["diagnostics", "usage"],
	}),
	withArgs(
		"access",
		"access",
		{
			description: "Directory access rules and path testing",
			usage: "/access [safe|restricted|test <path>]",
			tags: ["diagnostics", "safety"],
			examples: ["/access", "/access safe", "/access test ./logs/output.txt"],
		},
		{ completions: CommandCompletionKind.Access },
	),
	withArgs("pii", "pii", {
		description: "PII detection patterns and testing",
		usage: "/pii [patterns|test <text>]",
		tags: ["diagnostics", "security"],
		examples: ["/pii", "/pii patterns", "/pii test jane.doe@example.com"],
	}),
	withArgs("audit", "audit", {
		description: "Audit log status (enterprise)",
		usage: "/audit [status]",
		tags: ["diagnostics", "security"],
		examples: ["/audit", "/audit status"],
	}),
	withArgs("limits", "limits", {
		description: "Show configurable runtime limits",
		usage: "/limits [all|tool|tui|api|session|runtime|help]",
		tags: ["config", "diagnostics"],
		examples: ["/limits", "/limits tool", "/limits runtime"],
	}),
	withArgs("approvals", "approvals", {
		description:
			"Show approval status or switch between auto/prompt/fail modes",
		usage: "/approvals [auto|prompt|fail]",
		tags: ["safety"],
	}),
	withArgs("plan-mode", "planMode", {
		description: "Toggle plan mode (ask before write/edit/bash)",
		usage: "/plan-mode [on|off]",
		tags: ["safety"],
	}),
	withArgs("guardian", "guardian", {
		description:
			"Run Maestro Guardian (Semgrep + secrets) or toggle enforcement",
		usage: "/guardian [run|status|enable|disable|all]",
		tags: ["safety", "git"],
		examples: ["/guardian", "/guardian status", "/guardian disable"],
	}),
	withArgs("workflow", "workflow", {
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
	}),
	withArgs("framework", "framework", {
		description:
			"Set or show default framework (supports --workspace and list)",
		usage: "/framework [id|none|list] [--workspace]",
		tags: ["session"],
	}),
	withArgs("commands", "commands", {
		description: "List or run user commands from .maestro/commands",
		usage: "/commands list | /commands run <name> [k=v]...",
		tags: ["session", "automation"],
	}),
	withArgs("report", "report", {
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
	}),
	withArgs("thinking", "thinking", {
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
	}),
	exact("model", "model", {
		description: "Select model (opens selector UI)",
		usage: "/model",
		tags: ["session"],
	}),
	withArgs("mode", "mode", {
		description: "Switch agent mode (smart/rush/free)",
		usage: "/mode [smart|rush|free|list|suggest]",
		tags: ["session", "model"],
		examples: ["/mode", "/mode smart", "/mode rush", "/mode free"],
	}),
	exact("theme", "theme", {
		description: "Select color theme (opens selector with live preview)",
		usage: "/theme",
		tags: ["ui"],
	}),
	withArgs("clean", "clean", {
		description:
			"Toggle assistant text deduplication during live streaming only",
		usage: "/clean [off|soft|aggressive]",
		tags: ["ui"],
		examples: ["/clean", "/clean soft", "/clean off"],
	}),
	exact("new", "newChat", {
		description: "Start a fresh chat session",
		usage: "/new",
		tags: ["session"],
	}),
	withArgs("export", "exportSession", {
		description: "Export session to HTML, text, JSON, or JSONL",
		usage: "/export [path] [html|text|json|jsonl]",
		tags: ["session", "sharing"],
		aliases: ["e"],
	}),
	withArgs("share", "shareSession", {
		description: "Generate a self-contained HTML share link",
		usage: "/share [output.html]",
		tags: ["session", "sharing"],
	}),
	withArgs("import", "importConfig", {
		description: "Import configuration or portable session files",
		usage: "/import factory | /import session <file.json|file.jsonl>",
		tags: ["config"],
	}),
	withArgs("session", "session", {
		description: "Show session info, mark favorite, or add a manual summary",
		usage:
			'/session [info|favorite|unfavorite|summary "text"] (defaults: info)',
		tags: ["session"],
		aliases: ["s"],
	}),
	withArgs("sessions", "sessions", {
		description: "List, load, favorite, or summarize recent sessions by index",
		usage:
			"/sessions [list|load <id>|favorite <id>|unfavorite <id>|summarize <id>]",
		tags: ["session"],
	}),
	withArgs("history", "history", {
		description: "Show or search prompt history",
		usage: "/history [count|search query|clear]",
		tags: ["session"],
		aliases: ["hist"],
		examples: ["/history", "/history 25", "/history clear"],
	}),
	withArgs("branch", "branch", {
		description:
			"Create a new session from an earlier user message (keeps history up to that point)",
		usage: "/branch [list|<user-message-number>]",
		tags: ["session"],
	}),
	exact("tree", "tree", {
		description: "Navigate the session tree and switch branches",
		usage: "/tree",
		tags: ["session"],
	}),
	withArgs("queue", "queue", {
		description: "List, cancel, or change queue mode",
		usage: "/queue [list|cancel <id>|mode [steer|followup] <one|all>]",
		tags: ["session"],
	}),
	withArgs("steer", "steer", {
		description: "Interrupt current run and run a prompt next",
		usage: "/steer <message>",
		tags: ["session"],
		examples: ["/steer focus on tests next"],
	}),
	exact("about", "about", {
		description: "Show Maestro build, env, and git info",
		usage: "/about",
		tags: ["system", "diagnostics"],
	}),
	exact("clear", "clear", {
		description: "Clear context and start a fresh session",
		usage: "/clear",
		tags: ["session"],
	}),
	withArgs("plan", "plan", {
		description: "Show saved plans/checklists",
		usage: "/plan [id]",
		tags: ["planning"],
		aliases: ["p"],
	}),
	withArgs("init", "initAgents", {
		description: "Create or overwrite AGENTS.md scaffolding for this repo",
		usage: "/init [path]",
		tags: ["config"],
	}),
	withArgs("diff", "preview", {
		description: "Show git diff for a file",
		usage: "/diff <path>",
		tags: ["git"],
	}),
	exact("status", "status", {
		description: "Show health snapshot (model, git, plan, telemetry, training)",
		usage: "/status",
		tags: ["diagnostics"],
	}),
	withArgs("background", "background", {
		description: "Configure background task notifications and status redaction",
		usage: "/background [status|notify <on|off>|details <on|off>|history|path]",
		tags: ["diagnostics"],
		examples: [
			"/background",
			"/background notify on",
			"/background details on",
			"/background history",
			"/background path",
		],
	}),
	exact("review", "review", {
		description: "Summarize git status and diff stats",
		usage: "/review",
		tags: ["git"],
	}),
	withArgs("undo", "undoChanges", {
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
	}),
	withArgs("changes", "changes", {
		description: "List tracked file changes from this session",
		usage: "/changes [--files|--tools]",
		tags: ["undo", "diagnostics"],
		examples: ["/changes", "/changes --files", "/changes --tools"],
	}),
	withArgs("checkpoint", "checkpoint", {
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
	}),
	withArgs("memory", "memory", {
		description: "Cross-session and repo-scoped memory for facts and learnings",
		usage:
			"/memory [save|search|list|session|recent|team|delete|stats|export|import|clear]",
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
					"session",
					"recent",
					"team",
					"delete",
					"stats",
					"export",
					"import",
					"clear",
				],
			},
		],
		examples: [
			"/memory",
			"/memory save api-design Use REST conventions #rest",
			"/memory search REST",
			"/memory search REST --session",
			"/memory list",
			"/memory list api-design",
			"/memory session 5",
			"/memory team",
			"/memory team init",
			"/memory stats",
		],
	}),
	withArgs("mention", "mention", {
		description: "Search files to mention (same as @ search)",
		usage: "/mention <query>",
		tags: ["search"],
	}),
	withArgs(
		"run",
		"run",
		{
			description: "Run npm script (e.g. /run test --watch)",
			usage: "/run <script> [--flags]",
			tags: ["automation"],
			aliases: ["r"],
		},
		{ completions: CommandCompletionKind.RunScripts },
	),
	withArgs("ollama", "ollama", {
		description: "Control local Ollama models (list, pull, ps)",
		usage: "/ollama [list|pull <model>|ps]",
		tags: ["local", "models"],
		examples: ["/ollama list", "/ollama pull llama3", "/ollama ps"],
	}),
	exact("help", "help", {
		description: "List available slash commands",
		usage: "/help",
		tags: ["support"],
		aliases: ["h"],
	}),
	exact("update", "update", {
		description: "Check for Maestro CLI updates",
		usage: "/update",
		tags: ["system"],
	}),
	exact("changelog", "changelog", {
		description: "Display full version history",
		usage: "/changelog",
		tags: ["system"],
	}),
	withArgs(
		"hotkeys",
		"hotkeys",
		{
			description: "Show or manage keyboard shortcuts",
			usage: "/hotkeys [show|path|init|validate]",
			tags: ["help", "config"],
			aliases: ["keys", "shortcuts"],
			examples: [
				"/hotkeys",
				"/hotkeys path",
				"/hotkeys init",
				"/hotkeys validate",
			],
		},
		{ completions: CommandCompletionKind.Hotkeys },
	),
	withArgs(
		"package",
		"package",
		{
			description:
				"Manage, inspect, or validate Maestro package/plugin bundles",
			usage:
				"/package [add|remove|prune-cache|refresh|list|inspect|validate] [source] [--scope ...]",
			tags: ["tools", "config"],
			aliases: ["plugin"],
			examples: [
				"/package add ./packages/my-pack",
				"/package list",
				"/package remove ./packages/my-pack",
				"/package prune-cache",
				"/package refresh git:github.com/org/my-pack@main",
				"/package refresh --all",
				"/package inspect ./packages/my-pack",
				"/package validate ./packages/my-pack",
				"/plugin ./packages/my-pack",
			],
		},
		{ completions: CommandCompletionKind.Package },
	),
	withArgs("telemetry", "telemetry", {
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
	}),
	exact("otel", "otel", {
		description: "Show OpenTelemetry runtime configuration",
		usage: "/otel",
		tags: ["diagnostics", "telemetry"],
	}),
	withArgs("training", "training", {
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
	}),
	exact("config", "config", {
		description: "Validate and inspect Maestro configuration",
		usage: "/config [summary|sources|providers|env|files|help]",
		tags: ["config"],
		examples: ["/config", "/config sources"],
	}),
	withArgs("cost", "cost", {
		description: "Show usage and cost summary",
		usage: "/cost [period|breakdown <period>|clear|help]",
		tags: ["usage"],
		examples: ["/cost", "/cost breakdown week"],
	}),
	withArgs("quota", "quota", {
		description: "Show token quota status and usage limits",
		usage: "/quota [detailed|models|alerts|limit <tokens>|help]",
		tags: ["usage"],
		examples: [
			"/quota",
			"/quota detailed",
			"/quota models",
			"/quota limit 100000",
		],
	}),
	exact("stats", "stats", {
		description: "Show combined status and cost overview",
		usage: "/stats",
		tags: ["diagnostics", "usage"],
	}),
	diagnostics("diag", "diagnostics", {
		description: "Show provider/model/API key diagnostics",
		usage: "/diag [lsp|keys]",
		tags: ["diagnostics"],
		aliases: ["d", "diagnostics"],
	}),
	withArgs("mcp", "mcp", {
		description:
			"Show or manage Model Context Protocol servers and auth presets",
		usage:
			"/mcp [add|edit|remove|approve|deny|search|import|auth|resources|prompts]",
		tags: ["tools"],
		examples: [
			"/mcp",
			"/mcp search linear",
			"/mcp import linear",
			"/mcp approve linear",
			"/mcp auth add linear-auth --header 'Authorization: Bearer ...'",
			"/mcp add linear https://mcp.linear.app/mcp",
			"/mcp add linear https://mcp.linear.app/mcp --auth-preset linear-auth",
			"/mcp edit linear https://mcp.linear.app/mcp --header 'Authorization: Bearer ...'",
			"/mcp remove linear",
			"/mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .",
		],
	}),
	withArgs("lsp", "lsp", {
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
	}),
	withArgs("composer", "composer", {
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
	}),
	withArgs("prompts", "prompts", {
		description:
			"List/run prompt templates from markdown files (~/.maestro/prompts/, .maestro/prompts/).",
		usage: "/prompts [list|<name> [args]]",
		tags: ["automation", "session"],
		examples: [
			"/prompts",
			"/prompts list",
			"/prompts review FILE=src/main.ts",
			"/pr-review FILE=src/main.ts",
			'/prompts ticket TICKET_ID=123 TITLE="Fix bug"',
		],
	}),
	withArgs("compact", "compact", {
		description: "Summarize older messages to reclaim context",
		usage: "/compact [custom instructions]",
		tags: ["planning"],
		examples: [
			"/compact",
			"/compact Focus on the API changes",
			"/compact Emphasize database migrations",
		],
	}),
	withArgs("autocompact", "autocompact", {
		description: "Toggle or configure auto-compaction",
		usage: "/autocompact [on|off|status]",
		tags: ["planning"],
		examples: [
			"/autocompact",
			"/autocompact on",
			"/autocompact off",
			"/autocompact status",
		],
	}),
	withArgs("footer", "footer", {
		description: "Switch footer style or view/clear footer alerts",
		usage: "/footer [ensemble|solo|history|clear]",
		tags: ["ui"],
		examples: ["/footer", "/footer solo", "/footer history", "/footer clear"],
	}),
	withArgs(
		"alerts",
		"footer",
		{
			description: "Alias for footer alerts (history|clear)",
			usage: "/alerts [history|clear]",
			tags: ["ui"],
			examples: ["/alerts history", "/alerts clear"],
		},
		{ rewriteTo: "footer" },
	),
	withArgs("compact-tools", "compactTools", {
		description: "Toggle folding of tool outputs",
		usage: "/compact-tools [on|off]",
		tags: ["tools"],
	}),
	withArgs("login", "login", {
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
	}),
	withArgs("logout", "logout", {
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
	}),
	quit("quit", "quit", {
		description: "Exit composer (same as ctrl+c twice)",
		usage: "/quit",
		tags: ["system"],
		aliases: ["q", "exit"],
	}),
	exact("copy", "copy", {
		description: "Copy last assistant message to clipboard",
		usage: "/copy",
		tags: ["session"],
	}),
];

export const POST_SUITE_COMMAND_CATALOG: readonly CommandCatalogEntry[] = [
	withArgs("toolhistory", "toolHistory", {
		description: "Show tool execution history and stats",
		usage: "/toolhistory [count|stats|clear|tool <name>]",
		tags: ["tools"],
		aliases: ["th"],
		examples: ["/toolhistory", "/toolhistory stats", "/toolhistory read"],
	}),
	withArgs("skills", "skills", {
		description: "List or manage skills from SKILL.md",
		usage: "/skills [list|activate|deactivate|reload|info] [skill-name]",
		tags: ["tools"],
		aliases: ["skill"],
		examples: ["/skills", "/skills info my-skill", "/skills activate my-skill"],
	}),
];
