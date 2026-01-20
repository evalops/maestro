export type WebSlashCommand = {
	name: string;
	description: string;
	usage: string;
	tags?: string[];
};

export const WEB_SLASH_COMMANDS: WebSlashCommand[] = [
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
	{ name: "theme", description: "Select theme", usage: "/theme", tags: ["ui"] },
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
	},
	{
		name: "files",
		description: "List workspace files",
		usage: "/files [pattern]",
		tags: ["workspace"],
	},
	{
		name: "commands",
		description: "Open command palette",
		usage: "/commands",
		tags: ["ui"],
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
	{ name: "new", description: "New session", usage: "/new", tags: ["session"] },
];
