import type { SlashCommand } from "../../tui-lib/index.js";
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
				name: "thinking",
				description: "Select reasoning level (opens selector UI)",
				usage: "/thinking",
				tags: ["session"],
			},
			equals("thinking"),
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
				description: "Show session info and stats",
				usage: "/session",
				tags: ["session"],
			},
			equals("session"),
			handlers.sessionInfo,
			createContext,
		),
		buildEntry(
			{
				name: "sessions",
				description: "List or load recent sessions",
				usage: "/sessions [list|load <id>]",
				tags: ["session"],
			},
			withArgs("sessions"),
			handlers.sessions,
			createContext,
		),
		buildEntry(
			{
				name: "queue",
				description: "List or cancel queued prompts",
				usage: "/queue [list|cancel <id>]",
				tags: ["session"],
			},
			withArgs("queue"),
			handlers.queue,
			createContext,
		),
		buildEntry(
			{
				name: "bug",
				description: "Copy session info for bug reports",
				usage: "/bug",
				tags: ["support"],
			},
			equals("bug"),
			handlers.reportBug,
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
				name: "preview",
				description: "Preview git diff for a file",
				usage: "/preview <path>",
				tags: ["git"],
			},
			withArgs("preview"),
			handlers.preview,
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
				name: "feedback",
				description: "Copy a feedback template with session context",
				usage: "/feedback",
				tags: ["support"],
			},
			equals("feedback"),
			handlers.shareFeedback,
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
				name: "why",
				description: "Explain the last response/tools used",
				usage: "/why",
				tags: ["session"],
			},
			equals("why"),
			handlers.why,
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
		context.showError(parseResult.errors.join(" "));
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
