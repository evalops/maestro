import type { ComposerCommand, ComposerCommandArg } from "@evalops/contracts";

export type WebSlashCommand = {
	name: string;
	description: string;
	usage: string;
	tags?: string[];
	source?: "builtin" | "custom";
	supported?: boolean;
	prompt?: string;
	args?: ComposerCommandArg[];
};

const BUILTIN_WEB_SLASH_COMMANDS: Array<Omit<WebSlashCommand, "source">> = [
	{
		name: "help",
		description: "List commands",
		usage: "/help",
		tags: ["support"],
	},
	{
		name: "status",
		description: "Show workspace status",
		usage: "/status",
		tags: ["diagnostics"],
	},
	{
		name: "stats",
		description: "Show status and usage summary",
		usage: "/stats",
		tags: ["diagnostics", "usage"],
	},
	{
		name: "diag",
		description: "Show diagnostics",
		usage: "/diag [status|background|hooks|sandbox]",
		tags: ["diagnostics"],
	},
	{
		name: "run",
		description: "Run npm script",
		usage: "/run <script>",
		tags: ["automation"],
	},
	{
		name: "mcp",
		description: "Show, manage, or import MCP servers and auth presets",
		usage:
			"/mcp [status|search <query>|resources [server uri]|prompts [server [name KEY=value...]]|add <name> <command-or-url>|edit <name> <command-or-url>|remove <name>|import <id> [name]|auth [list|add|edit|remove]]",
		tags: ["tools"],
	},
	{
		name: "memory",
		description: "Search and manage cross-session memory",
		usage:
			"/memory [save <topic> <content>|search <query>|list [topic]|recent [N]|delete <id|topic>|stats|export [path]|import <path>|clear --force]",
		tags: ["memory", "session"],
	},
	{
		name: "diff",
		description: "Show git diff",
		usage: "/diff <path>",
		tags: ["git"],
	},
	{
		name: "review",
		description: "Summarize git status/diff",
		usage: "/review",
		tags: ["git"],
	},
	{
		name: "git",
		description: "Git status, diff, and review",
		usage: "/git [status|diff <path>|review]",
		tags: ["git"],
	},
	{
		name: "history",
		description: "Show prompt history",
		usage: "/history [count|search query|clear]",
		tags: ["session"],
		supported: false,
	},
	{
		name: "plan",
		description: "Show saved plans",
		usage: "/plan",
		tags: ["planning"],
	},
	{
		name: "branch",
		description: "Create session branch",
		usage: "/branch [list|<message#>]",
		tags: ["session"],
	},
	{
		name: "model",
		description: "Select model",
		usage: "/model",
		tags: ["session"],
	},
	{
		name: "theme",
		description: "Select theme",
		usage: "/theme",
		tags: ["ui"],
	},
	{
		name: "zen",
		description: "Toggle zen mode",
		usage: "/zen [on|off]",
		tags: ["ui"],
	},
	{
		name: "clean",
		description: "Set clean mode",
		usage: "/clean [off|soft|aggressive]",
		tags: ["ui"],
	},
	{
		name: "footer",
		description: "Set footer mode",
		usage: "/footer [ensemble|solo]",
		tags: ["ui"],
	},
	{
		name: "config",
		description: "Inspect config",
		usage: "/config",
		tags: ["config"],
	},
	{
		name: "limits",
		description: "Show runtime limits",
		usage: "/limits [all|tool|tui|api|session|runtime|help]",
		tags: ["config", "diagnostics"],
		supported: false,
	},
	{
		name: "files",
		description: "List workspace files",
		usage: "/files [pattern]",
		tags: ["workspace"],
	},
	{
		name: "commands",
		description: "Open command palette or run custom commands",
		usage: "/commands [list|run <name> arg=value]",
		tags: ["ui", "custom"],
	},
	{
		name: "toolhistory",
		description: "Show tool execution history",
		usage: "/toolhistory [count|stats|clear|tool <name>]",
		tags: ["tools"],
		supported: false,
	},
	{
		name: "skills",
		description: "List or manage skills",
		usage: "/skills [list|activate|deactivate|reload|info] [skill-name]",
		tags: ["tools"],
		supported: false,
	},
	{
		name: "cost",
		description: "Show usage/cost",
		usage: "/cost",
		tags: ["usage"],
	},
	{
		name: "telemetry",
		description: "Toggle telemetry",
		usage: "/telemetry [on|off]",
		tags: ["diagnostics"],
	},
	{
		name: "approvals",
		description: "Set approval mode",
		usage: "/approvals [auto|prompt|fail]",
		tags: ["safety"],
	},
	{
		name: "queue",
		description: "Manage prompt queue",
		usage: "/queue [list|mode]",
		tags: ["planning"],
	},
	{
		name: "transport",
		description: "Set streaming transport",
		usage: "/transport [auto|sse|ws]",
		tags: ["diagnostics"],
	},
	{
		name: "new",
		description: "New session",
		usage: "/new",
		tags: ["session"],
	},
];

const escapeRegExp = (value: string): string =>
	value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const formatCustomCommandArg = (arg: ComposerCommandArg): string =>
	arg.required ? `${arg.name}=<value>` : `[${arg.name}=<value>]`;

export const WEB_SLASH_COMMANDS: WebSlashCommand[] =
	BUILTIN_WEB_SLASH_COMMANDS.map((command) => ({
		...command,
		source: "builtin",
	}));

export function isWebSlashCommandSupported(command: WebSlashCommand): boolean {
	return command.supported !== false;
}

export function buildCustomCommandUsage(
	command: Pick<ComposerCommand, "name" | "args">,
): string {
	const suffix = (command.args ?? []).map(formatCustomCommandArg).join(" ");
	return suffix ? `/${command.name} ${suffix}` : `/${command.name}`;
}

export function buildWebSlashCommands(
	customCommands: ComposerCommand[],
): WebSlashCommand[] {
	const seen = new Set(WEB_SLASH_COMMANDS.map((command) => command.name));
	const custom = customCommands
		.filter((command) => !seen.has(command.name))
		.map((command) => ({
			name: command.name,
			description: command.description ?? "Custom prompt template",
			usage: buildCustomCommandUsage(command),
			tags: command.args?.length ? ["custom", "args"] : ["custom"],
			source: "custom" as const,
			supported: true,
			prompt: command.prompt,
			args: command.args ?? [],
		}));
	return [...WEB_SLASH_COMMANDS, ...custom];
}

export function findCustomWebSlashCommand(
	commands: WebSlashCommand[],
	name: string,
): WebSlashCommand | undefined {
	const normalized = name.toLowerCase();
	return commands.find(
		(command) =>
			command.source === "custom" && command.name.toLowerCase() === normalized,
	);
}

export function parseCustomWebSlashCommandArgs(
	argumentText: string,
): Record<string, string> {
	const args: Record<string, string> = {};
	for (const token of argumentText.split(/\s+/).filter(Boolean)) {
		const eqIndex = token.indexOf("=");
		if (eqIndex <= 0) continue;
		const key = token.slice(0, eqIndex);
		const value = token.slice(eqIndex + 1);
		args[key] = value;
	}
	return args;
}

export function renderCustomWebSlashCommand(
	command: Pick<WebSlashCommand, "args" | "name" | "prompt" | "usage">,
	argumentText: string,
): { ok: true; prompt: string } | { ok: false; error: string } {
	if (!command.prompt) {
		return {
			ok: false,
			error: `Command /${command.name} is missing a prompt template.`,
		};
	}

	const args = parseCustomWebSlashCommandArgs(argumentText);
	for (const arg of command.args ?? []) {
		if (arg.required && !args[arg.name]) {
			return {
				ok: false,
				error: `Missing required arg: ${arg.name}\nUsage: ${command.usage}`,
			};
		}
	}

	let prompt = command.prompt;
	for (const [key, value] of Object.entries(args)) {
		const pattern = new RegExp(`{{${escapeRegExp(key)}}}`, "g");
		prompt = prompt.replace(pattern, value);
	}

	return { ok: true, prompt };
}
