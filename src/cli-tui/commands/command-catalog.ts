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

export type CommandCatalogEntry = {
	command: SlashCommand;
	handlerKey: keyof CommandHandlers;
	match: {
		kind: CommandMatchKind;
		aliases?: string[];
	};
	completions?: CommandCompletionKind;
	rewriteTo?: string;
};

export const PRIMARY_COMMAND_CATALOG: readonly CommandCatalogEntry[] = [
	{
		command: {
			name: "zen",
			description: "Toggle Zen Mode (hides header, ensures minimal footer)",
			usage: "/zen [on|off]",
			tags: ["ui"],
			examples: ["/zen", "/zen on", "/zen off"],
		},
		handlerKey: "zen",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
			name: "context",
			description: "Visualize context usage (tokens per message/file)",
			usage: "/context",
			tags: ["diagnostics", "usage"],
		},
		handlerKey: "context",
		match: { kind: CommandMatchKind.Exact },
	},
	{
		command: {
			name: "access",
			description: "Directory access rules and path testing",
			usage: "/access [safe|restricted|test <path>]",
			tags: ["diagnostics", "safety"],
			examples: ["/access", "/access safe", "/access test ./logs/output.txt"],
		},
		handlerKey: "access",
		match: { kind: CommandMatchKind.WithArgs },
		completions: CommandCompletionKind.Access,
	},
	{
		command: {
			name: "pii",
			description: "PII detection patterns and testing",
			usage: "/pii [patterns|test <text>]",
			tags: ["diagnostics", "security"],
			examples: ["/pii", "/pii patterns", "/pii test jane.doe@example.com"],
		},
		handlerKey: "pii",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
			name: "audit",
			description: "Audit log status (enterprise)",
			usage: "/audit [status]",
			tags: ["diagnostics", "security"],
			examples: ["/audit", "/audit status"],
		},
		handlerKey: "audit",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
			name: "limits",
			description: "Show configurable runtime limits",
			usage: "/limits [all|tool|tui|api|session|runtime|help]",
			tags: ["config", "diagnostics"],
			examples: ["/limits", "/limits tool", "/limits runtime"],
		},
		handlerKey: "limits",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
			name: "approvals",
			description:
				"Show approval status or switch between auto/prompt/fail modes",
			usage: "/approvals [auto|prompt|fail]",
			tags: ["safety"],
		},
		handlerKey: "approvals",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
			name: "plan-mode",
			description: "Toggle plan mode (ask before write/edit/bash)",
			usage: "/plan-mode [on|off]",
			tags: ["safety"],
		},
		handlerKey: "planMode",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
			name: "guardian",
			description:
				"Run Maestro Guardian (Semgrep + secrets) or toggle enforcement",
			usage: "/guardian [run|status|enable|disable|all]",
			tags: ["safety", "git"],
			examples: ["/guardian", "/guardian status", "/guardian disable"],
		},
		handlerKey: "guardian",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
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
		handlerKey: "workflow",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
			name: "framework",
			description:
				"Set or show default framework (supports --workspace and list)",
			usage: "/framework [id|none|list] [--workspace]",
			tags: ["session"],
		},
		handlerKey: "framework",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
			name: "commands",
			description: "List or run user commands from .maestro/commands",
			usage: "/commands list | /commands run <name> [k=v]...",
			tags: ["session", "automation"],
		},
		handlerKey: "commands",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
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
		handlerKey: "report",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
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
		handlerKey: "thinking",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
			name: "model",
			description: "Select model (opens selector UI)",
			usage: "/model",
			tags: ["session"],
		},
		handlerKey: "model",
		match: { kind: CommandMatchKind.Exact },
	},
	{
		command: {
			name: "mode",
			description: "Switch agent mode (smart/rush/free)",
			usage: "/mode [smart|rush|free|list|suggest]",
			tags: ["session", "model"],
			examples: ["/mode", "/mode smart", "/mode rush", "/mode free"],
		},
		handlerKey: "mode",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
			name: "theme",
			description: "Select color theme (opens selector with live preview)",
			usage: "/theme",
			tags: ["ui"],
		},
		handlerKey: "theme",
		match: { kind: CommandMatchKind.Exact },
	},
	{
		command: {
			name: "clean",
			description:
				"Toggle assistant text deduplication during live streaming only",
			usage: "/clean [off|soft|aggressive]",
			tags: ["ui"],
			examples: ["/clean", "/clean soft", "/clean off"],
		},
		handlerKey: "clean",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
			name: "new",
			description: "Start a fresh chat session",
			usage: "/new",
			tags: ["session"],
		},
		handlerKey: "newChat",
		match: { kind: CommandMatchKind.Exact },
	},
	{
		command: {
			name: "export",
			description: "Export session to HTML, text, JSON, or JSONL",
			usage: "/export [path] [html|text|json|jsonl]",
			tags: ["session", "sharing"],
			aliases: ["e"],
		},
		handlerKey: "exportSession",
		match: { kind: CommandMatchKind.WithArgs, aliases: ["e"] },
	},
	{
		command: {
			name: "share",
			description: "Generate a self-contained HTML share link",
			usage: "/share [output.html]",
			tags: ["session", "sharing"],
		},
		handlerKey: "shareSession",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
			name: "import",
			description: "Import configuration or portable session files",
			usage: "/import factory | /import session <file.json|file.jsonl>",
			tags: ["config"],
		},
		handlerKey: "importConfig",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
			name: "session",
			description: "Show session info, mark favorite, or add a manual summary",
			usage:
				'/session [info|favorite|unfavorite|summary "text"] (defaults: info)',
			tags: ["session"],
			aliases: ["s"],
		},
		handlerKey: "session",
		match: { kind: CommandMatchKind.WithArgs, aliases: ["s"] },
	},
	{
		command: {
			name: "sessions",
			description:
				"List, load, favorite, or summarize recent sessions by index",
			usage:
				"/sessions [list|load <id>|favorite <id>|unfavorite <id>|summarize <id>]",
			tags: ["session"],
		},
		handlerKey: "sessions",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
			name: "history",
			description: "Show or search prompt history",
			usage: "/history [count|search query|clear]",
			tags: ["session"],
			aliases: ["hist"],
			examples: ["/history", "/history 25", "/history clear"],
		},
		handlerKey: "history",
		match: { kind: CommandMatchKind.WithArgs, aliases: ["hist"] },
	},
	{
		command: {
			name: "branch",
			description:
				"Create a new session from an earlier user message (keeps history up to that point)",
			usage: "/branch [list|<user-message-number>]",
			tags: ["session"],
		},
		handlerKey: "branch",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
			name: "tree",
			description: "Navigate the session tree and switch branches",
			usage: "/tree",
			tags: ["session"],
		},
		handlerKey: "tree",
		match: { kind: CommandMatchKind.Exact },
	},
	{
		command: {
			name: "queue",
			description: "List, cancel, or change queue mode",
			usage: "/queue [list|cancel <id>|mode [steer|followup] <one|all>]",
			tags: ["session"],
		},
		handlerKey: "queue",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
			name: "steer",
			description: "Interrupt current run and run a prompt next",
			usage: "/steer <message>",
			tags: ["session"],
			examples: ["/steer focus on tests next"],
		},
		handlerKey: "steer",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
			name: "about",
			description: "Show Maestro build, env, and git info",
			usage: "/about",
			tags: ["system", "diagnostics"],
		},
		handlerKey: "about",
		match: { kind: CommandMatchKind.Exact },
	},
	{
		command: {
			name: "clear",
			description: "Clear context and start a fresh session",
			usage: "/clear",
			tags: ["session"],
		},
		handlerKey: "clear",
		match: { kind: CommandMatchKind.Exact },
	},
	{
		command: {
			name: "plan",
			description: "Show saved plans/checklists",
			usage: "/plan [id]",
			tags: ["planning"],
			aliases: ["p"],
		},
		handlerKey: "plan",
		match: { kind: CommandMatchKind.WithArgs, aliases: ["p"] },
	},
	{
		command: {
			name: "init",
			description: "Create or overwrite AGENTS.md scaffolding for this repo",
			usage: "/init [path]",
			tags: ["config"],
		},
		handlerKey: "initAgents",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
			name: "diff",
			description: "Show git diff for a file",
			usage: "/diff <path>",
			tags: ["git"],
		},
		handlerKey: "preview",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
			name: "status",
			description:
				"Show health snapshot (model, git, plan, telemetry, training)",
			usage: "/status",
			tags: ["diagnostics"],
		},
		handlerKey: "status",
		match: { kind: CommandMatchKind.Exact },
	},
	{
		command: {
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
		handlerKey: "background",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
			name: "review",
			description: "Summarize git status and diff stats",
			usage: "/review",
			tags: ["git"],
		},
		handlerKey: "review",
		match: { kind: CommandMatchKind.Exact },
	},
	{
		command: {
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
		handlerKey: "undoChanges",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
			name: "changes",
			description: "List tracked file changes from this session",
			usage: "/changes [--files|--tools]",
			tags: ["undo", "diagnostics"],
			examples: ["/changes", "/changes --files", "/changes --tools"],
		},
		handlerKey: "changes",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
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
		handlerKey: "checkpoint",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
			name: "memory",
			description:
				"Cross-session and repo-scoped memory for facts and learnings",
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
		},
		handlerKey: "memory",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
			name: "mention",
			description: "Search files to mention (same as @ search)",
			usage: "/mention <query>",
			tags: ["search"],
		},
		handlerKey: "mention",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
			name: "run",
			description: "Run npm script (e.g. /run test --watch)",
			usage: "/run <script> [--flags]",
			tags: ["automation"],
			aliases: ["r"],
		},
		handlerKey: "run",
		match: { kind: CommandMatchKind.WithArgs, aliases: ["r"] },
		completions: CommandCompletionKind.RunScripts,
	},
	{
		command: {
			name: "ollama",
			description: "Control local Ollama models (list, pull, ps)",
			usage: "/ollama [list|pull <model>|ps]",
			tags: ["local", "models"],
			examples: ["/ollama list", "/ollama pull llama3", "/ollama ps"],
		},
		handlerKey: "ollama",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
			name: "help",
			description: "List available slash commands",
			usage: "/help",
			tags: ["support"],
			aliases: ["h"],
		},
		handlerKey: "help",
		match: { kind: CommandMatchKind.Exact, aliases: ["h"] },
	},
	{
		command: {
			name: "update",
			description: "Check for Maestro CLI updates",
			usage: "/update",
			tags: ["system"],
		},
		handlerKey: "update",
		match: { kind: CommandMatchKind.Exact },
	},
	{
		command: {
			name: "changelog",
			description: "Display full version history",
			usage: "/changelog",
			tags: ["system"],
		},
		handlerKey: "changelog",
		match: { kind: CommandMatchKind.Exact },
	},
	{
		command: {
			name: "hotkeys",
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
		handlerKey: "hotkeys",
		match: { kind: CommandMatchKind.WithArgs, aliases: ["keys", "shortcuts"] },
		completions: CommandCompletionKind.Hotkeys,
	},
	{
		command: {
			name: "package",
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
		handlerKey: "package",
		match: { kind: CommandMatchKind.WithArgs, aliases: ["plugin"] },
		completions: CommandCompletionKind.Package,
	},
	{
		command: {
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
		handlerKey: "telemetry",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
			name: "otel",
			description: "Show OpenTelemetry runtime configuration",
			usage: "/otel",
			tags: ["diagnostics", "telemetry"],
		},
		handlerKey: "otel",
		match: { kind: CommandMatchKind.Exact },
	},
	{
		command: {
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
		handlerKey: "training",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
			name: "config",
			description: "Validate and inspect Maestro configuration",
			usage: "/config [summary|sources|providers|env|files|help]",
			tags: ["config"],
			examples: ["/config", "/config sources"],
		},
		handlerKey: "config",
		match: { kind: CommandMatchKind.Exact },
	},
	{
		command: {
			name: "cost",
			description: "Show usage and cost summary",
			usage: "/cost [period|breakdown <period>|clear|help]",
			tags: ["usage"],
			examples: ["/cost", "/cost breakdown week"],
		},
		handlerKey: "cost",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
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
		handlerKey: "quota",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
			name: "stats",
			description: "Show combined status and cost overview",
			usage: "/stats",
			tags: ["diagnostics", "usage"],
		},
		handlerKey: "stats",
		match: { kind: CommandMatchKind.Exact },
	},
	{
		command: {
			name: "diag",
			description: "Show provider/model/API key diagnostics",
			usage: "/diag [lsp|keys]",
			tags: ["diagnostics"],
			aliases: ["d", "diagnostics"],
		},
		handlerKey: "diagnostics",
		match: { kind: CommandMatchKind.Diagnostics },
	},
	{
		command: {
			name: "mcp",
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
		},
		handlerKey: "mcp",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
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
		handlerKey: "lsp",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
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
		handlerKey: "composer",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
			name: "prompts",
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
		},
		handlerKey: "prompts",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
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
		handlerKey: "compact",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
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
		handlerKey: "autocompact",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
			name: "footer",
			description: "Switch footer style or view/clear footer alerts",
			usage: "/footer [ensemble|solo|history|clear]",
			tags: ["ui"],
			examples: ["/footer", "/footer solo", "/footer history", "/footer clear"],
		},
		handlerKey: "footer",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
			name: "alerts",
			description: "Alias for footer alerts (history|clear)",
			usage: "/alerts [history|clear]",
			tags: ["ui"],
			examples: ["/alerts history", "/alerts clear"],
		},
		handlerKey: "footer",
		match: { kind: CommandMatchKind.WithArgs },
		rewriteTo: "footer",
	},
	{
		command: {
			name: "compact-tools",
			description: "Toggle folding of tool outputs",
			usage: "/compact-tools [on|off]",
			tags: ["tools"],
		},
		handlerKey: "compactTools",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
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
		handlerKey: "login",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
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
		handlerKey: "logout",
		match: { kind: CommandMatchKind.WithArgs },
	},
	{
		command: {
			name: "quit",
			description: "Exit composer (same as ctrl+c twice)",
			usage: "/quit",
			tags: ["system"],
			aliases: ["q", "exit"],
		},
		handlerKey: "quit",
		match: { kind: CommandMatchKind.Quit },
	},
	{
		command: {
			name: "copy",
			description: "Copy last assistant message to clipboard",
			usage: "/copy",
			tags: ["session"],
		},
		handlerKey: "copy",
		match: { kind: CommandMatchKind.Exact },
	},
];

export const POST_SUITE_COMMAND_CATALOG: readonly CommandCatalogEntry[] = [
	{
		command: {
			name: "toolhistory",
			description: "Show tool execution history and stats",
			usage: "/toolhistory [count|stats|clear|tool <name>]",
			tags: ["tools"],
			aliases: ["th"],
			examples: ["/toolhistory", "/toolhistory stats", "/toolhistory read"],
		},
		handlerKey: "toolHistory",
		match: { kind: CommandMatchKind.WithArgs, aliases: ["th"] },
	},
	{
		command: {
			name: "skills",
			description: "List or manage skills from SKILL.md",
			usage: "/skills [list|activate|deactivate|reload|info] [skill-name]",
			tags: ["tools"],
			aliases: ["skill"],
			examples: [
				"/skills",
				"/skills info my-skill",
				"/skills activate my-skill",
			],
		},
		handlerKey: "skills",
		match: { kind: CommandMatchKind.WithArgs, aliases: ["skill"] },
	},
];
