import type { SlashCommand } from "@evalops/tui";
import { parseCommandArguments, shouldShowHelp } from "./argument-parser.js";
import type {
	CommandEntry,
	CommandExecutionContext,
	CommandRegistryOptions,
} from "./types.js";

const equals = (name: string) => (input: string) => input === `/${name}`;

const withArgs = (name: string) => (input: string) =>
	input === `/${name}` || input.startsWith(`/${name} `);

const matchDiagnostics = (input: string) =>
	input === "/diag" || input.startsWith("/diag ") || input === "/diagnostics";

const matchQuit = (input: string) => input === "/quit" || input === "/exit";

export function createCommandRegistry({
	getRunScriptCompletions,
	handlers,
	createContext,
}: CommandRegistryOptions): CommandEntry[] {
	const entries: CommandEntry[] = [
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
			},
			withArgs("export"),
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
		buildEntry(
			{
				name: "tools",
				description: "Show available tools, failures, or clear logs",
				usage: "/tools [list|failures|clear]",
				tags: ["tools"],
			},
			withArgs("tools"),
			handlers.tools,
			createContext,
		),
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
			},
			withArgs("session"),
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
			},
			withArgs("sessions"),
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
			},
			withArgs("plan"),
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
				description: "Show health snapshot (model, git, plan, telemetry)",
				usage: "/status",
				tags: ["diagnostics"],
			},
			equals("status"),
			handlers.status,
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
				description: "Discard local changes in files via git checkout",
				usage: "/undo <path>",
				tags: ["git"],
			},
			withArgs("undo"),
			handlers.undoChanges,
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
				getArgumentCompletions: getRunScriptCompletions,
			},
			withArgs("run"),
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
			},
			equals("help"),
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
				aliases: ["diagnostics"],
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
				name: "compact",
				description: "Summarize older messages to reclaim context",
				usage: "/compact",
				tags: ["planning"],
			},
			equals("compact"),
			handlers.compact,
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
				aliases: ["exit"],
			},
			matchQuit,
			handlers.quit,
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
